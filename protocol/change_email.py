"""Interactive web-session email change, following the supplied HAR contract."""
import json
import re
import sys
from urllib.parse import urljoin, urlsplit

from runner import parse_notes
from totp import TotpMfaClient
from vendor.lib.chatgpt_client import ChatGPTClient
from vendor.lib.oauth_client import OAuthClient

BASE = "https://chatgpt.com"
CLIENT_ID = "TdJIcbe16WoTHtN95nyywh5E4yOo6ItG"


def read_code(emit, step):
    emit("step", step=step)
    command = json.loads(sys.stdin.readline(1024))
    code = command.get("code", "")
    if not isinstance(code, str) or not re.fullmatch(r"[0-9]{6}", code):
        raise ValueError("credentials")
    return code


class ManualMail:
    def __init__(self, emit):
        self.emit = emit

    def wait_for_verification_code(self, *args, **kwargs):
        return read_code(self.emit, "email_login_code")


class WebOAuth(OAuthClient):
    def _oauth_complete_add_phone_for_continue(self, *args, **kwargs):
        raise ValueError("phone")


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
    mail = ManualMail(emit)
    next_url = oauth._oauth_drive_external_login_for_continue(
        email=email, password=password, current_url=current,
        device_id=chat.device_id, user_agent=chat.ua, impersonate=chat.impersonate,
        mail_client=mail, mfa_client=TotpMfaClient(secret, max_attempts=1),
    )
    for _ in range(20):
        if not next_url:
            raise ValueError("login")
        current = safe_url(urljoin(current, next_url))
        if "mfa-challenge" in urlsplit(current).path:
            emit("step", step="mfa")
            next_url = oauth._oauth_complete_totp_mfa_for_continue(
                device_id=chat.device_id, user_agent=chat.ua, impersonate=chat.impersonate,
                mfa_client=TotpMfaClient(secret, max_attempts=1), current_url=current,
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
                emit("error", code="email_" + operation + "_rejected", httpStatus=response.status_code)
                return
        emit("email_complete")
    except Exception:
        # A lost verify response may already have changed the remote email
        emit("error", code="email_verify_uncertain" if stage == "verify" else "email_" + stage + "_failed")
    finally:
        chat.session.close()
