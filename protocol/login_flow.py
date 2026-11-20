"""Current password/TOTP request fields and response-session metadata adapter."""
import json
from urllib.parse import urljoin, urlsplit


def build_sentinel_token(*args, **kwargs):
    from vendor.lib.oauth_client import build_sentinel_token as upstream
    return upstream(*args, **kwargs)


class LoginFlowMixin:
    response_session = None
    password_submitted = False
    totp_submitted = False
    login_password = ""
    login_device_id = ""
    login_user_agent = ""
    login_impersonate = None

    def _infer_external_page_type(self, url, text):
        page = super()._infer_external_page_type(url, text)
        # The email-first landing page still offers the supplied password method
        return "log-in" if page == "email-verification" and not self.password_submitted else page

    def _oauth_drive_external_login_for_continue(self, **kwargs):
        if getattr(self, "session_continuation", False) or self.password_submitted:
            self.last_oauth_error = "session_login_required"
            return ""
        current = kwargs.get("current_url") or self.oauth_issuer + "/log-in"
        self.login_email, self.login_password = kwargs.get("email", ""), kwargs.get("password", "")
        self.login_device_id = kwargs.get("device_id", "")
        self.login_user_agent, self.login_impersonate = kwargs.get("user_agent", ""), kwargs.get("impersonate")
        if urlsplit(current).path not in {"/email-verification", "/log-in/password"}:
            token = build_sentinel_token(self.session, self.login_device_id, flow="authorize_continue",
                                         user_agent=self.login_user_agent, impersonate=self.login_impersonate)
            if not token:
                self.last_oauth_error = "login_continue_failed"
                return ""
            response = self._oauth_request(
                "POST", self.oauth_issuer + "/api/accounts/authorize/continue",
                json={"username": {"kind": "email", "value": self.login_email}, "screen_hint": "login_or_signup"},
                headers={"Accept": "application/json", "Content-Type": "application/json",
                         "Origin": self.oauth_issuer, "Referer": current,
                         "User-Agent": self.login_user_agent, "oai-device-id": self.login_device_id,
                         "openai-sentinel-token": token},
                timeout=30, allow_redirects=False, impersonate=self.login_impersonate,
            )
            if response.status_code != 200:
                return ""
            body = response.json()
            current = urljoin(current, self._extract_continue_url_from_json(body))
            if self._is_mfa_challenge(data=body, continue_url=current):
                return self._oauth_complete_totp_mfa_for_continue(
                    device_id=self.login_device_id, user_agent=self.login_user_agent,
                    impersonate=self.login_impersonate, mfa_client=kwargs.get("mfa_client"),
                    current_url=current, response_data=body,
                )
            if self._oauth_page_type(body) not in {"login_password", "email_otp_verification", "contact_verification"} and urlsplit(current).path not in {"/email-verification", "/log-in/password"}:
                return current
        return self._password_login_for_continue(
            continue_url=current, mfa_client=kwargs.get("mfa_client"),
        )

    def _oauth_request(self, method, url, **kwargs):
        parsed = urlsplit(url)
        trusted = parsed.scheme == "https" and parsed.netloc == "auth.openai.com"
        path = parsed.path if trusted else ""
        desktop_entry = method.upper() == "GET" and parsed.scheme == "https" and parsed.netloc == "chatgpt.com" and parsed.path == "/codex/desktop-auth"
        if not trusted and not desktop_entry:
            self.last_oauth_error = "login_continue_failed"
            raise ValueError("authorization")
        if method.upper() == "POST" and path == "/api/accounts/authorize/continue":
            body = dict(kwargs.get("json") or {})
            body["screen_hint"] = "login_or_signup"
            kwargs["json"] = body
        if method.upper() == "POST" and path == "/api/accounts/password/verify":
            if self.password_submitted or getattr(self, "session_continuation", False):
                self.last_oauth_error = "session_login_required"
                raise ValueError("session_login_required")
            self.password_submitted = True
        if method.upper() == "POST" and path == "/api/accounts/mfa/verify":
            if self.totp_submitted or getattr(self, "session_continuation", False):
                self.last_oauth_error = "session_login_required"
                raise ValueError("session_login_required")
            self.totp_submitted = True
            headers = dict(kwargs.get("headers") or {})
            token = build_sentinel_token(
                self.session, self.login_device_id, flow="verify_mfa",
                user_agent=self.login_user_agent, impersonate=self.login_impersonate,
            )
            if not token:
                self.last_oauth_error = "mfa_totp_verification_failed"
                raise ValueError("mfa_totp_verification_failed")
            headers["openai-sentinel-token"] = token
            kwargs["headers"] = headers
        response = super()._oauth_request(method, url, **kwargs)
        # The latest successful auth API response replaces the previous snapshot
        # Never synthesize cookies or merge old workspace bindings into a new session
        if trusted and path.startswith("/api/accounts/") and 200 <= response.status_code < 300:
            try:
                body = response.json()
            except (ValueError, TypeError):
                body = None
            if isinstance(body, dict) and "oai-client-auth-session" in body:
                session = body["oai-client-auth-session"]
                if not isinstance(session, dict) or len(json.dumps(session)) > 65536:
                    raise ValueError("authorization")
                for identity in [session.get("email"), (session.get("username") or {}).get("value") if isinstance(session.get("username"), dict) else None]:
                    if identity is not None and (not isinstance(identity, str) or identity.casefold() != self.login_email.casefold()):
                        raise ValueError("fallback_identity")
                self.response_session = session
        return response

    def _decode_oauth_session_cookie(self):
        if self.response_session is not None:
            return self.response_session
        return super()._decode_oauth_session_cookie()

    def _oauth_complete_email_otp_for_continue(self, **kwargs):
        return self._password_login_for_continue(**kwargs)

    def _password_login_for_continue(self, **kwargs):
        if self.password_submitted or not self.login_password or getattr(self, "session_continuation", False):
            self.last_oauth_error = "session_login_required" if getattr(self, "session_continuation", False) else "email_otp_provider_required"
            return ""
        token = build_sentinel_token(
            self.session, self.login_device_id, flow="password_verify",
            user_agent=self.login_user_agent, impersonate=self.login_impersonate,
        )
        if not token:
            self.last_oauth_error = "login_continue_failed"
            return ""
        response = self._oauth_request(
            "POST", self.oauth_issuer + "/api/accounts/password/verify",
            json={"password": self.login_password}, allow_redirects=False, timeout=30,
            impersonate=self.login_impersonate,
            headers={"Accept": "application/json", "Content-Type": "application/json",
                     "Origin": self.oauth_issuer, "Referer": self.oauth_issuer + "/log-in/password",
                     "oai-device-id": self.login_device_id, "User-Agent": self.login_user_agent,
                     "openai-sentinel-token": token},
        )
        if response.status_code != 200:
            return ""
        body = response.json()
        current = kwargs.get("continue_url") or self.oauth_issuer
        next_url = urljoin(current, self._extract_continue_url_from_json(body))
        if self._is_mfa_challenge(data=body, continue_url=next_url):
            return self._oauth_complete_totp_mfa_for_continue(
                device_id=self.login_device_id, user_agent=self.login_user_agent,
                impersonate=self.login_impersonate, mfa_client=kwargs.get("mfa_client"),
                current_url=next_url, response_data=body,
            )
        if "email-verification" in urlsplit(next_url).path:
            self.last_oauth_error = "email_otp_provider_required"
            return ""
        return next_url
