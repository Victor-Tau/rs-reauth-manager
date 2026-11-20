"""Offline web login and captured email-change contract; no real accounts/network."""
import io
import json
from pathlib import Path
import sys
import types
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "protocol"))
import change_email
import runner
from requests.cookies import RequestsCookieJar
from vendor.lib import chatgpt_client, oauth_client

EMAIL = "old@example.com"
NEW = "new@example.com"
SECRET = "GEZDGNBVGY3TQOJQ"


class EmailChangeTests(unittest.TestCase):
    def execute(self, *, begin=(200, {"success": True}), verify=(200, {"success": True}),
                identity=EMAIL, codes='{"code":"445566"}\n', redirect=None, phone=False, login_mail=False):
        calls, messages, sessions = [], [], []

        class Session:
            def __init__(self):
                self.headers = {}
                self.cookies = RequestsCookieJar()
                self.closed = False
                sessions.append(self)

            def request(self, method, url, **kw):
                calls.append((self, method, url, kw))
                status, body, headers = 200, {}, {"Content-Type": "application/json"}
                if url == "https://chatgpt.com/":
                    pass
                elif url.endswith("/api/auth/csrf"):
                    body = {"csrfToken": "private-csrf"}
                elif url.endswith("/api/auth/signin/openai"):
                    body = {"url": "https://auth.openai.com/oauth/authorize?state=private-state"}
                elif "/oauth/authorize?" in url:
                    status, headers = 302, {"Location": redirect or "https://auth.openai.com/log-in"}
                elif url.endswith("/api/accounts/authorize/continue"):
                    body = {"page": {"type": "login_password"}, "continue_url": "/log-in/password"}
                elif url.endswith("/api/accounts/password/verify"):
                    assert kw["json"] == {"password": "private-password"}
                    if phone:
                        body = {"page": {"type": "add_phone"}, "continue_url": "/add-phone"}
                    elif login_mail:
                        body = {"page": {"type": "email_otp_verification"}, "continue_url": "/email-verification"}
                    else:
                        body = {"page": {"type": "mfa_challenge"}, "continue_url": "/mfa-challenge/fixture-factor", "factors": [{"id": "fixture-factor", "type": "totp"}]}
                elif url.endswith("/api/accounts/mfa/issue_challenge"):
                    pass
                elif url.endswith("/api/accounts/mfa/verify"):
                    assert kw["json"]["code"] == "123456"
                    body = {"continue_url": "https://auth.openai.com/api/accounts/authorize/callback"}
                elif url.endswith("/api/accounts/authorize/callback"):
                    status, headers = 302, {"Location": "https://chatgpt.com/api/auth/callback/openai?code=private-code&state=private-state"}
                elif "/api/auth/callback/openai?" in url:
                    status, headers = 302, {"Location": "/"}
                elif url.endswith("/api/auth/session"):
                    body = {"accessToken": "private-access", "user": {"email": identity, "id": "fixture-user"}, "account": {"id": "fixture-account"}}
                elif url.endswith("/change_email/begin"):
                    status, body = begin
                elif url.endswith("/change_email/verify"):
                    if isinstance(verify, Exception):
                        raise verify
                    status, body = verify
                elif url.endswith("/api/accounts/email-otp/resend"):
                    pass
                elif url.endswith("/api/accounts/email-otp/validate"):
                    assert kw["json"] == {"code": "112233"}
                    body = {"continue_url": "https://auth.openai.com/api/accounts/authorize/callback"}
                elif url.endswith(("/log-in", "/log-in/password", "/mfa-challenge/fixture-factor")):
                    pass
                else:
                    raise AssertionError("Unexpected offline request " + method + " " + url)
                return types.SimpleNamespace(status_code=status, json=lambda: body, headers=headers, text=json.dumps(body), url=url)

            def get(self, url, **kw):
                return self.request("GET", url, **kw)

            def post(self, url, **kw):
                return self.request("POST", url, **kw)

            def close(self):
                self.closed = True

        data = {"mode": "change_email", "email": EMAIL, "notes": f"{EMAIL}----private-password----{SECRET}", "newEmail": NEW, "proxy": "socks5://fixture:pass@127.0.0.1:21001"}
        with patch.object(chatgpt_client, "create_http_session", side_effect=lambda **kw: Session()) as create_chat, \
             patch.object(oauth_client, "create_http_session", side_effect=lambda **kw: Session()), \
             patch.object(oauth_client, "build_sentinel_token", return_value="private-sentinel"), \
             patch.object(change_email.TotpMfaClient, "get_mfa_code", return_value="123456"), \
             patch.object(sys, "stdin", io.StringIO(codes)), \
             patch.object(runner, "emit", side_effect=lambda event, **fields: messages.append({"event": event, **fields})):
            runner.run(data)
        self.assertTrue(all(s is sessions[0] for s, _, _, _ in calls))
        self.assertTrue(all(s.closed for s in sessions))
        self.assertEqual(create_chat.call_args.kwargs["proxy"], data["proxy"].replace("socks5://", "socks5h://"))
        encoded = json.dumps(messages)
        for value in [SECRET, "private-", "445566", "112233", "fixture:pass"]:
            self.assertNotIn(value, encoded)
        return messages, calls

    def test_password_totp_web_callback_then_exact_har_begin_and_verify_same_session(self):
        messages, calls = self.execute()
        self.assertEqual(messages[-1], {"event": "email_complete"})
        changes = [(method, url, kw) for _, method, url, kw in calls if "/change_email/" in url]
        self.assertEqual(len(changes), 2)
        self.assertEqual(changes[0][:2], ("POST", "https://chatgpt.com/backend-api/accounts/change_email/begin"))
        self.assertEqual(changes[0][2]["json"], {"email": NEW, "auth0_client_id": "TdJIcbe16WoTHtN95nyywh5E4yOo6ItG"})
        self.assertEqual(changes[1][2]["json"], {"email": NEW, "code": "445566"})
        for _, _, kw in changes:
            self.assertFalse(kw["allow_redirects"])
            self.assertEqual(kw["headers"]["Authorization"], "Bearer private-access")
            self.assertEqual(kw["headers"]["chatgpt-account-id"], "fixture-account")
        self.assertEqual(sum(url.endswith("/password/verify") for _, _, url, _ in calls), 1)
        self.assertEqual(sum(url.endswith("/mfa/verify") for _, _, url, _ in calls), 1)

    def test_login_email_otp_is_manual_and_distinct_from_new_email_code(self):
        messages, _ = self.execute(login_mail=True, codes='{"code":"112233"}\n{"code":"445566"}\n')
        self.assertEqual(messages[-1]["event"], "email_complete")
        steps = [m.get("step") for m in messages]
        self.assertLess(steps.index("email_login_code"), steps.index("email_code"))

    def test_wrong_identity_phone_and_external_redirect_stop_before_change(self):
        for args in [{"identity": "someone@example.com"}, {"phone": True}, {"redirect": "https://attacker.invalid/"}]:
            with self.subTest(args=args):
                messages, calls = self.execute(**args)
                self.assertEqual(messages[-1]["event"], "error")
                self.assertFalse(any("/change_email/" in url for _, _, url, _ in calls))
                self.assertFalse(any("attacker.invalid" in url for _, _, url, _ in calls))

    def test_begin_failure_never_submits_verify(self):
        for status, body in [(403, {}), (429, {}), (200, {"success": False}), (302, {})]:
            messages, calls = self.execute(begin=(status, body))
            self.assertEqual(messages[-1]["code"], "email_begin_rejected")
            self.assertEqual(sum("/change_email/" in url for _, _, url, _ in calls), 1)

    def test_verify_lost_response_is_uncertain_and_not_retried(self):
        messages, calls = self.execute(verify=TimeoutError("private-access private-password"))
        self.assertEqual(messages[-1], {"event": "error", "code": "email_verify_uncertain"})
        self.assertEqual(sum(url.endswith("/change_email/verify") for _, _, url, _ in calls), 1)

    def test_verify_requires_exact_success_and_invalid_code_is_not_sent(self):
        messages, _ = self.execute(verify=(200, {"success": False}))
        self.assertEqual(messages[-1]["code"], "email_verify_rejected")
        for code in ["", "12345", "１２３４５６", "abcdef"]:
            messages, calls = self.execute(codes=json.dumps({"code": code}) + "\n")
            self.assertEqual(messages[-1]["event"], "error")
            self.assertFalse(any(url.endswith("/change_email/verify") for _, _, url, _ in calls))


if __name__ == "__main__":
    unittest.main()
