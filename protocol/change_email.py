"""Interactive web-session email change, following the supplied HAR contract."""
import json
import re
import sys
from urllib.parse import urljoin, urlsplit

from runner import parse_notes
from totp import TotpMfaClient
from vendor.lib.chatgpt_client import ChatGPTClient
from vendor.lib.oauth_client import OAuthClient
from vendor.lib.sentinel_token import build_sentinel_token
from login_flow import LoginFlowMixin
from email_trace import EmailTrace

BASE = "https://chatgpt.com"
CLIENT_ID = "TdJIcbe16WoTHtN95nyywh5E4yOo6ItG"


def read_code(emit, step):
    emit("step", step=step)
    command = json.loads(sys.stdin.readline(1024))
    code = command.get("code", "")
    if not isinstance(code, str) or not re.fullmatch(r"[0-9]{6}", code):
        raise ValueError("credentials")
    return code


class WebOAuth(LoginFlowMixin, OAuthClient):
    password_attempted = False
    password_verified = False
    mfa_verified = False

    def _oauth_request(self, method, url, **kwargs):
        safe_url(url)
        if urlsplit(url).path == "/api/accounts/password/verify":
            if self.password_attempted:
                raise ValueError("login")
            self.password_attempted = True
        response = super()._oauth_request(method, url, **kwargs)
        if urlsplit(url).path == "/api/accounts/password/verify" and response.status_code == 200:
            self.password_verified = True
        return response

    def _oauth_complete_totp_mfa_for_continue(self, **kwargs):
        if not self.password_verified or self.mfa_verified:
            raise ValueError("login")
        self.emit("step", step="mfa")
        result = super()._oauth_complete_totp_mfa_for_continue(**kwargs)
        if result and not self.last_oauth_error:
            self.mfa_verified = True
        else:
            raise ValueError("email_login_mfa_rejected")
        return result

    def _oauth_complete_email_otp_for_continue(self, **kwargs):
        # Never select email OTP as a substitute for the supplied password and TOTP
        raise ValueError("email_login_human")

    def _oauth_complete_add_phone_for_continue(self, *args, **kwargs):
        raise ValueError("phone")

    def verify_password(self, password, current_url):
        token = build_sentinel_token(self.session, self.device_id, flow="password_verify",
                                     user_agent=self.user_agent, impersonate=self.impersonate)
        if not token:
            raise ValueError("login")
        response = self._oauth_request(
            "POST", self.oauth_issuer + "/api/accounts/password/verify",
            json={"password": password}, allow_redirects=False, timeout=30,
            impersonate=self.impersonate,
            headers={"Accept": "application/json", "Content-Type": "application/json",
                     "Origin": self.oauth_issuer, "Referer": self.oauth_issuer + "/",
                     "oai-device-id": self.device_id, "User-Agent": self.user_agent,
                     "openai-sentinel-token": token},
        )
        if response.status_code != 200:
            raise ValueError("email_login_password_rejected")
        data = response.json()
        next_url = safe_url(urljoin(current_url, self._extract_continue_url_from_json(data)))
        if self._is_mfa_challenge(data=data, continue_url=next_url):
            return self._oauth_complete_totp_mfa_for_continue(
                device_id=self.device_id, user_agent=self.user_agent, impersonate=self.impersonate,
                mfa_client=self.mfa_client, current_url=next_url, response_data=data,
            )
        return next_url


def safe_url(value):
    parsed = urlsplit(value)
    if parsed.scheme != "https" or parsed.netloc not in {"chatgpt.com", "auth.openai.com"}:
        raise ValueError("authorization")
    return value


def web_login(chat, email, password, secret, emit):
    emit("step", step="login")
    if not chat.visit_homepage():
        raise ValueError("login")
    csrf = chat.get_csrf_token()
    start = chat.signin(email, csrf) if csrf else None
    if not start:
        raise ValueError("login")
    # Obtain the web authorize session without exchanging any desktop OAuth tokens
    current = safe_url(start)
    for _ in range(16):
        response = chat.session.get(current, allow_redirects=False, timeout=30)
        if response.status_code in {301, 302, 303, 307, 308}:
            current = safe_url(urljoin(current, response.headers.get("Location", "")))
            continue
        if response.status_code != 200:
            raise ValueError("login")
        break
    else:
        raise ValueError("login")
    oauth = WebOAuth({"oauth_email_otp_max_attempts": 1, "sub2api_oauth_impersonates": [chat.impersonate]}, proxy=chat.proxy, verbose=False)
    # OAuthClient's constructor creates a session that is not used here
    oauth.session.close()
    oauth.session = chat.session
    oauth.device_id, oauth.user_agent, oauth.impersonate = chat.device_id, chat.ua, chat.impersonate
    oauth.login_email, oauth.login_password = email, password
    oauth.login_device_id, oauth.login_user_agent, oauth.login_impersonate = chat.device_id, chat.ua, chat.impersonate
    oauth.mfa_client, oauth.emit = TotpMfaClient(secret, max_attempts=1), emit
    if urlsplit(current).path in {"/email-verification", "/log-in/password"}:
        next_url = oauth.verify_password(password, current)
    elif urlsplit(current).path in {"/log-in", "/log-in-or-create-account"}:
        next_url = oauth._oauth_drive_external_login_for_continue(
            email=email, password=password, current_url=current,
            device_id=chat.device_id, user_agent=chat.ua, impersonate=chat.impersonate,
            mail_client=None, mfa_client=oauth.mfa_client,
        )
    else:
        raise ValueError("login")
    for _ in range(20):
        if not next_url:
            raise ValueError("login")
        current = safe_url(urljoin(current, next_url))
        if urlsplit(current).netloc == "auth.openai.com" and urlsplit(current).path in {"/email-verification", "/log-in/password"}:
            if oauth.password_attempted:
                raise ValueError("email_login_human")
            next_url = oauth.verify_password(password, current)
            continue
        if "mfa-challenge" in urlsplit(current).path:
            next_url = oauth._oauth_complete_totp_mfa_for_continue(
                device_id=chat.device_id, user_agent=chat.ua, impersonate=chat.impersonate,
                mfa_client=oauth.mfa_client, current_url=current,
            )
            continue
        response = chat.session.get(current, allow_redirects=False, timeout=30)
        if response.status_code in {301, 302, 303, 307, 308}:
            next_url = response.headers.get("Location", "")
            continue
        if response.status_code != 200:
            raise ValueError("login")
        if urlsplit(current).netloc == "chatgpt.com":
            break
        # Unknown consent, phone or security pages need an explicit supported flow
        raise ValueError("login")
    else:
        raise ValueError("login")
    if not oauth.password_verified or not oauth.mfa_verified:
        raise ValueError("login")
    response = chat.session.get(BASE + "/api/auth/session", allow_redirects=False, timeout=30)
    session = response.json() if response.status_code == 200 else {}
    if str((session.get("user") or {}).get("email", "")).casefold() != email.casefold():
        raise ValueError("identity")
    token = session.get("accessToken")
    if not isinstance(token, str) or not token or any(c.isspace() or ord(c) < 32 for c in token):
        raise ValueError("login")
    return session


def run_change_email(data, emit):
    email, password, secret = parse_notes(data["notes"], data["email"])
    new_email = data["newEmail"]
    proxy = data.get("proxy")
    if not isinstance(proxy, str) or proxy and (urlsplit(proxy).scheme not in {"http", "https", "socks5", "socks5h"} or not urlsplit(proxy).hostname):
        raise ValueError("proxy")
    chat = ChatGPTClient(proxy=proxy or None, verbose=False)
    stage = "login"
    trace = EmailTrace(chat.session, emit)
    try:
        # No implicit replay of state-changing requests, including on requests fallback
        import requests
        if isinstance(chat.session, requests.Session):
            chat.session.mount("https://", requests.adapters.HTTPAdapter(max_retries=0))
        session = web_login(chat, email, password, secret, emit)
        headers = {"Accept": "application/json", "Content-Type": "application/json",
                   "Origin": BASE, "Referer": BASE + "/", "oai-device-id": chat.device_id,
                   "Authorization": "Bearer " + session["accessToken"]}
        account = (session.get("account") or {}).get("id")
        if isinstance(account, str) and re.fullmatch(r"[A-Za-z0-9_-]{1,128}", account):
            headers["chatgpt-account-id"] = account
        for operation, payload in [("begin", {"email": new_email, "auth0_client_id": CLIENT_ID}),
                                   ("verify", None)]:
            if operation == "verify":
                payload = {"email": new_email, "code": read_code(emit, "email_code")}
            stage = operation
            emit("step", step="email_" + operation)
            response = chat.session.post(BASE + "/backend-api/accounts/change_email/" + operation,
                                         json=payload, headers=headers, allow_redirects=False, timeout=30)
            if response.status_code != 200 or response.json() != {"success": True}:
                emit("error", code="email_" + operation + "_rejected", httpStatus=response.status_code, diagnostic=trace.diagnostic())
                return
        emit("email_complete")
    except Exception as exc:
        # A lost verify response may already have changed the remote email
        code = "email_verify_uncertain" if stage == "verify" else "email_" + stage + "_failed"
        if stage == "login" and isinstance(exc, ValueError) and str(exc) in {"email_login_human", "email_login_password_rejected", "email_login_mfa_rejected"}:
            code = str(exc)
        reason = {"email_login_human": "email_otp_provider_required", "email_login_password_rejected": "invalid_username_or_password", "email_login_mfa_rejected": "mfa_totp_verification_failed", "identity": "fallback_identity", "phone": "phone_required", "authorization": "login_continue_failed"}.get(str(exc), str(exc) if isinstance(exc, ValueError) else None)
        emit("error", code=code, diagnostic=trace.diagnostic(reason))
    finally:
        chat.session.close()
