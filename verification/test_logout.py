"""Offline contract tests; never reuse captured account credentials."""
import json
from pathlib import Path
import sys
import types
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "protocol"))
import logout
import runner


class LogoutTests(unittest.TestCase):
    def setUp(self):
        self.data = {"mode": "logout", "proxy": "http://fixture:pass@127.0.0.1:21001", "accessToken": "private-access", "accountId": "fixture-account", "cookies": [{"name": "fixture", "value": "private-cookie"}]}
        self.messages, self.calls = [], []

    def execute(self, status=200, body=None, error=None):
        test = self
        class Session:
            def request(self, method, url, **kwargs):
                test.calls.append((method, url, kwargs))
                if error:
                    raise error
                return types.SimpleNamespace(status_code=status, json=lambda: body)
            def close(self):
                pass
        with patch.object(logout, "create_http_session", return_value=Session()) as create, patch.object(runner, "emit", side_effect=lambda event, **kw: self.messages.append({"event": event, **kw})):
            runner.run(self.data)
        return create

    def test_captured_contract_uses_selected_identity_empty_body_and_original_proxy(self):
        create = self.execute()
        create.assert_called_once_with(proxy=self.data["proxy"], impersonate="chrome133a")
        self.assertEqual(self.messages[-1], {"event": "logout_complete"})
        method, url, args = self.calls[0]
        self.assertEqual((method, url), ("POST", "https://chatgpt.com/backend-api/accounts/logout_all"))
        self.assertEqual(args["data"], b"")
        self.assertIs(args["allow_redirects"], False)
        self.assertEqual(args["headers"]["Authorization"], "Bearer private-access")
        self.assertEqual(args["headers"]["ChatGPT-Account-ID"], "fixture-account")
        self.assertEqual(args["headers"]["Cookie"], "fixture=private-cookie")
        self.assertNotIn("private-", json.dumps(self.messages))

    def test_no_redirect_retry_or_success_from_unexpected_response(self):
        for status, body in [(302, None), (500, None), (200, {}), (204, None)]:
            with self.subTest(status=status, body=body):
                self.calls.clear()
                self.execute(status, body)
                self.assertEqual(len(self.calls), 1)
                self.assertEqual(self.messages[-1]["code"], "logout_uncertain")

    def test_rejected_authorization_and_rate_limit_do_not_login_or_refresh(self):
        for status in [401, 403, 429]:
            self.calls.clear()
            self.execute(status, {"error": "private-response"})
            self.assertEqual(len(self.calls), 1)
            self.assertEqual(self.messages[-1], {"event": "error", "code": "logout_rejected", "httpStatus": status})

    def test_timeout_is_uncertain_and_does_not_leak_exception_or_retry(self):
        self.execute(error=TimeoutError("private-access private-cookie private-body"))
        self.assertEqual(len(self.calls), 1)
        self.assertEqual(self.messages[-1], {"event": "error", "code": "logout_uncertain"})

    def test_missing_proxy_token_identity_and_header_injection_stop_before_network(self):
        for key, value in [("proxy", ""), ("accessToken", ""), ("accessToken", "bad\r\nvalue"), ("accountId", ""), ("cookies", [{"name": "bad;name", "value": "value"}]), ("cookies", [{"name": "fixture", "value": "bad\r\nvalue"}])]:
            with self.subTest(key=key, value=value):
                data = dict(self.data, **{key: value})
                with patch.object(logout, "create_http_session", side_effect=AssertionError("No network allowed")), patch.object(runner, "emit") as emit:
                    runner.run(data)
                emit.assert_called_once_with("error", code="logout_credentials")

    def test_requests_fallback_disables_post_retries(self):
        import requests
        session = requests.Session()
        def request(*args, **kwargs):
            self.assertEqual(session.get_adapter(logout.URL).max_retries.total, 0)
            return types.SimpleNamespace(status_code=200, json=lambda: None)
        with patch.object(logout, "create_http_session", return_value=session), patch.object(session, "request", side_effect=request), patch.object(runner, "emit") as emit:
            runner.run(self.data)
        emit.assert_called_with("logout_complete")


if __name__ == "__main__":
    unittest.main()
