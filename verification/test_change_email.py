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
                identity=EMAIL, codes='{"code":"445566"}\n', redirect=None, phone=False, login_mail=False,
                password_status=200, mfa_status=200, password_error=None, mfa_sentinel=True, mfa_redirect=None):
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
                    status, headers = 302, {"Location": redirect or "https://auth.openai.com/email-verification"}
                elif url.endswith("/api/accounts/authorize/continue"):
                    body = {"page": {"type": "login_password"}, "continue_url": "/log-in/password"}
                elif url.endswith("/api/accounts/password/verify"):
                    assert kw["json"] == {"password": "private-password"}
                    assert kw['headers']['openai-sentinel-token'] == 'private-sentinel-password_verify'
                    if password_error:
                        raise password_error
                    status = password_status
                    if phone:
                        body = {"page": {"type": "add_phone"}, "continue_url": "/add-phone"}
                    elif login_mail:
                        body = {"page": {"type": "email_otp_verification"}, "continue_url": "/email-verification"}
                    else:
                        body = {"page": {"type": "mfa_challenge", "payload": {"factor_id": "fixture-factor", "factors": [{"id": "fixture-factor", "factor_type": "totp"}]}}, "continue_url": "/mfa-challenge/fixture-factor"}
                elif url.endswith("/api/accounts/mfa/issue_challenge"):
                    pass
                elif url.endswith("/api/accounts/mfa/verify"):
                    assert kw["json"]["code"] == "123456"
                    assert kw['headers']['openai-sentinel-token'] == 'private-sentinel-verify_mfa'
                    status = mfa_status
                    body = {"continue_url": mfa_redirect or "https://chatgpt.com/api/auth/callback/openai?code=private-code&state=private-state", "page": {"type": "external_url"}}
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
                elif url.endswith(("/log-in", "/log-in-or-create-account", "/log-in/password", "/mfa-challenge/fixture-factor", "/email-verification")):
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
             patch.object(oauth_client, "build_sentinel_token", side_effect=lambda *args, **kwargs: (None if not mfa_sentinel and kwargs['flow'] == 'verify_mfa' else 'private-sentinel-' + kwargs['flow'])), \
             patch.object(change_email, "build_sentinel_token", side_effect=lambda *args, **kwargs: (None if not mfa_sentinel and kwargs['flow'] == 'verify_mfa' else 'private-sentinel-' + kwargs['flow'])), \
             patch.object(change_email.TotpMfaClient, "get_mfa_code", return_value="123456"), \
             patch.object(sys, "stdin", io.StringIO(codes)), \
             patch.object(runner, "emit", side_effect=lambda event, **fields: messages.append({"event": event, **fields})):
            runner.run(data)
        self.assertTrue(all(s is sessions[0] for s, _, _, _ in calls))
        self.assertTrue(all(s.closed for s in sessions))
        self.assertFalse(any('passwordless/' in url or 'email-otp/' in url for _, _, url, _ in calls))
        self.assertFalse(any(m.get('step') == 'email_login_code' for m in messages))
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

    def test_detailed_request_logs_and_failure_stage_are_public_only(self):
        messages, _ = self.execute()
        entries = [m['entry'] for m in messages if m['event'] == 'diagnostic']
        for stage in ['web_home', 'web_csrf', 'web_signin', 'password', 'mfa_issue', 'mfa_verify', 'web_callback', 'web_session', 'change_begin', 'change_verify']:
            self.assertTrue(any(e['action'] == 'request' and e['stage'] == stage for e in entries), stage)
            self.assertTrue(any(e['action'] == 'response' and e['stage'] == stage and e['elapsedMs'] >= 0 and e['responseBytes'] >= 0 for e in entries), stage)
        for args, stage, reason, status in [({'password_status': 401}, 'password', 'password_rejected', 401), ({'password_status': 429}, 'password', 'rate_limited', 429), ({'password_error': TimeoutError('private-url')}, 'password', 'request_timeout', None), ({'begin': (403, {})}, 'change_begin', 'http_rejected', 403)]:
            failed, _ = self.execute(**args)
            self.assertEqual(failed[-1]['diagnostic'], {'stage': stage, 'reason': reason, 'httpStatus': status})

    def test_captured_email_verification_landing_switches_to_password_then_totp(self):
        messages, calls = self.execute()
        self.assertEqual(messages[-1]['event'], 'email_complete')
        endpoints = [url.split('?')[0] for _, _, url, _ in calls]
        self.assertIn('https://auth.openai.com/email-verification', endpoints)
        self.assertNotIn('https://auth.openai.com/api/accounts/authorize/continue', endpoints)
        self.assertLess(endpoints.index('https://auth.openai.com/api/accounts/password/verify'), endpoints.index('https://auth.openai.com/api/accounts/mfa/verify'))
        self.assertEqual([m.get('step') for m in messages if m.get('step') in {'email_login_code', 'email_code'}], ['email_code'])

    def test_explicit_password_page_and_normal_login_page_still_use_password_and_totp(self):
        for path in ['/log-in/password', '/log-in', '/log-in-or-create-account']:
            messages, calls = self.execute(redirect='https://auth.openai.com' + path)
            self.assertEqual(messages[-1]['event'], 'email_complete')
            self.assertEqual(sum(url.endswith('/password/verify') for _, _, url, _ in calls), 1)
            self.assertEqual(sum(url.endswith('/mfa/verify') for _, _, url, _ in calls), 1)

    def test_post_password_email_requirement_stops_without_fallback_or_replay(self):
        messages, calls = self.execute(login_mail=True)
        self.assertEqual(messages[-1]['code'], 'email_login_human')
        self.assertEqual(messages[-1]['diagnostic']['reason'], 'email_code_required')
        self.assertEqual(sum(url.endswith('/password/verify') for _, _, url, _ in calls), 1)
        self.assertFalse(any('/change_email/' in url for _, _, url, _ in calls))

    def test_password_rejected_and_timeout_do_not_fallback_or_retry(self):
        for args in [{'password_status': 401}, {'password_status': 429}, {'password_error': TimeoutError('private-password')}]:
            messages, calls = self.execute(**args)
            self.assertEqual(messages[-1]['event'], 'error')
            self.assertEqual(sum(url.endswith('/password/verify') for _, _, url, _ in calls), 1)
            self.assertFalse(any('/mfa/verify' in url or '/change_email/' in url for _, _, url, _ in calls))

    def test_mfa_rejection_missing_sentinel_or_extra_challenge_stops_before_change(self):
        for args in [{'mfa_status': 403}, {'mfa_status': 429}, {'mfa_sentinel': False}, {'mfa_redirect': '/mfa-challenge/fixture-factor'}, {'mfa_redirect': 'https://attacker.invalid/'}]:
            messages, calls = self.execute(**args)
            self.assertEqual(messages[-1]['event'], 'error')
            self.assertLessEqual(sum(url.endswith('/mfa/verify') for _, _, url, _ in calls), 1)
            self.assertFalse(any('/change_email/' in url or 'attacker.invalid' in url for _, _, url, _ in calls))

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
        self.assertEqual(messages[-1]["code"], "email_verify_uncertain")
        self.assertEqual(messages[-1]["diagnostic"], {"stage": "change_verify", "reason": "request_timeout", "httpStatus": None})
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
