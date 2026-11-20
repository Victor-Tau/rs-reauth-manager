"""Sanitized fixtures for the current Team and Plus/Pro Codex login captures."""
import base64
import hashlib
import json
from pathlib import Path
import socket
import sys
import types
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "protocol"))
import runner
from test_protocol import EMAIL, SECRET, URL, desktop_url
from urllib.parse import parse_qs, urlsplit
from test_fallback import jwt
import time
from requests.cookies import RequestsCookieJar
from vendor.lib import chatgpt_client, oauth_client


class CodexLoginTests(unittest.TestCase):
    def execute(self, *, plan="team", mode="import", target="", state="fixture",
                mfa_status=200, password_status=200, session_email=EMAIL,
                workspaces=None, landing="/log-in-or-create-account", cookie=True, bounce=False, verify_original=False, token_workspace=None):
        calls, messages, sessions = [], [], []
        choices = workspaces if workspaces is not None else [
            {"id": "team-workspace", "name": "Example Team", "kind": "organization"},
            {"id": "personal-workspace", "name": None, "kind": "personal"},
        ]
        consent = "https://auth.openai.com/sign-in-with-chatgpt/codex/consent"
        testcase = self

        class Session:
            def __init__(self):
                self.cookies, self.headers = RequestsCookieJar(), {}
                self.closed = False
                self.authorizations = 0
                self.callback = f"http://127.0.0.1:1455/auth/callback?code=private-code&state={state}"
                self.code_challenge = None
                sessions.append(self)
                if cookie:
                    self.cookies.set("oai-client-auth-session", json.dumps({"workspace_id": "stale-workspace", "workspaces": [{"id": "stale-workspace"}]}), domain="auth.openai.com")

            def close(self):
                self.closed = True

            def post(self, url, **kwargs):
                return self.request("POST", url, **kwargs)

            def request(self, method, url, **kwargs):
                calls.append((self, method, url, kwargs))
                body, status, headers = {}, 200, {"Content-Type": "application/json"}
                if verify_original and method == 'POST' and url.endswith('/oauth/token'):
                    challenge = base64.urlsafe_b64encode(hashlib.sha256(kwargs['data']['code_verifier'].encode()).digest()).decode().rstrip('=')
                    testcase.assertEqual(challenge, self.code_challenge)
                    testcase.assertEqual(kwargs['data']['code'], 'private-code')
                    payload = {'sub': 'original-subject', 'email': EMAIL, 'exp': int(time.time()) + 3600, 'https://api.openai.com/auth': {'chatgpt_account_id': token_workspace or target, 'chatgpt_user_id': 'original-user', 'chatgpt_plan_type': plan}}
                    token = jwt(payload)
                    body = {'id_token': token, 'access_token': token, 'refresh_token': 'private-fresh-refresh'}
                elif method == "GET" and (url == URL or verify_original and url.startswith('https://auth.openai.com/oauth/authorize?')):
                    self.authorizations += 1
                    if verify_original and self.authorizations == 1:
                        params = parse_qs(urlsplit(url).query)
                        testcase.assertNotEqual(params['state'], ['fixture'])
                        self.code_challenge = params['code_challenge'][0]
                        testcase.assertNotEqual(self.code_challenge, 'a' * 43)
                        if state == 'fixture':
                            self.callback = f"http://127.0.0.1:1455/auth/callback?code=private-code&state={params['state'][0]}"
                    status, headers = (307, {"Location": desktop_url()}) if bounce and self.authorizations == 1 else (302, {"Location": "https://auth.openai.com" + landing})
                elif method == "GET" and url == desktop_url():
                    status, headers = 302, {"Location": URL}
                elif method == "GET" and url.endswith(("/log-in-or-create-account", "/log-in/password", "/email-verification", "/mfa-challenge")):
                    pass
                elif method == "POST" and url.endswith("/authorize/continue"):
                    assert kwargs["json"] == {"username": {"kind": "email", "value": EMAIL}, "screen_hint": "login_or_signup"}
                    assert kwargs["headers"]["openai-sentinel-token"] == "private-authorize_continue"
                    body = {"continue_url": "/email-verification" if plan == "team" else "/log-in/password", "page": {"type": "email_otp_verification" if plan == "team" else "login_password"},
                            "oai-client-auth-session": {"email": session_email, "session_id": "private-session"}}
                elif method == "POST" and url.endswith("/password/verify"):
                    assert kwargs["json"] == {"password": "fixture-password"}
                    assert kwargs["headers"]["openai-sentinel-token"] == "private-password_verify"
                    status = password_status
                    body = {"continue_url": "/mfa-challenge", "page": {"type": "mfa_challenge", "payload": {"factor_id": "private-factor", "factors": [{"id": "private-factor", "factor_type": "totp"}]}},
                            "oai-client-auth-session": {"email": session_email, "mfa_factors": [{"id": "private-factor", "factor_type": "totp"}]}}
                    if status != 200:
                        body = {"error": {"code": "invalid_username_or_password"}}
                elif method == "POST" and url.endswith("/mfa/issue_challenge"):
                    assert kwargs["json"] == {"id": "private-factor", "type": "totp", "force_fresh_challenge": False}
                    body = {"oai-client-auth-session": {"email": session_email, "mfa_factors": [{"id": "private-factor", "factor_type": "totp"}]}}
                elif method == "POST" and url.endswith("/mfa/verify"):
                    assert kwargs["json"] == {"id": "private-factor", "type": "totp", "code": "123456"}
                    assert kwargs["headers"]["openai-sentinel-token"] == "private-verify_mfa"
                    status = mfa_status
                    snapshot = {"email": session_email, "email_verified": True}
                    if plan == "team" or target:
                        snapshot["workspaces"] = choices
                    body = {"continue_url": consent if plan == "team" else self.callback,
                            "page": {"type": "sign_in_with_chatgpt_codex_consent" if plan == "team" else "external_url"},
                            "oai-client-auth-session": snapshot}
                    if status != 200:
                        body = {"error": {"code": "rate_limit_exceeded"}}
                elif method == "GET" and url == consent:
                    headers = {"Content-Type": "text/html"}
                    body = {"page": "sign_in_with_chatgpt_codex_consent"}
                elif method == "POST" and url.endswith("/workspace/select"):
                    wanted = target or choices[0]["id"]
                    assert kwargs["json"] == {"workspace_id": wanted}
                    assert wanted != "stale-workspace"
                    body = {"continue_url": self.callback, "page": {"type": "external_url", "payload": {"url": self.callback}},
                            "oai-client-auth-session": {"email": session_email, "workspaces": choices}}
                else:
                    raise AssertionError("Unexpected offline request: " + method + " " + url)
                return types.SimpleNamespace(status_code=status, url=url, headers=headers, text=json.dumps(body), json=lambda: body)

        data = {"mode": mode, "email": EMAIL, "notes": f"{EMAIL}----fixture-password----{SECRET}", "authorizationUrl": desktop_url(), "accountId": target, "proxy": ""}
        if verify_original:
            data["userId"] = "original-user"
        with patch.object(chatgpt_client, "create_http_session", side_effect=lambda **kw: Session()), \
             patch.object(oauth_client, "create_http_session", side_effect=lambda **kw: Session()), \
             patch.object(oauth_client, "build_sentinel_token", side_effect=lambda *a, **kw: "private-" + kw["flow"]), \
             patch.object(runner, "emit", side_effect=lambda event, **kw: messages.append({"event": event, **kw})), \
             patch("totp.TotpMfaClient.get_mfa_code", return_value="123456"), \
             patch.object(socket, "create_connection", side_effect=AssertionError("Network forbidden")):
            try:
                runner.run(data)
            except ValueError as exc:
                if str(exc) != "fallback_identity":
                    raise
                messages.append({"event": "error", "code": "fallback_identity"})
        self.assertTrue(all(s is sessions[0] for s, _, _, _ in calls))
        self.assertTrue(all(s.closed for s in sessions))
        self.assertFalse(any("passwordless/" in u or "email-otp/" in u for _, _, u, _ in calls))
        self.assertLessEqual(sum(u.endswith("/password/verify") for _, _, u, _ in calls), 1)
        self.assertLessEqual(sum(u.endswith("/mfa/verify") for _, _, u, _ in calls), 1)
        for secret in ["fixture-password", "private-session", "private-factor", "private-verify_mfa", "123456"]:
            self.assertNotIn(secret, json.dumps(messages))
        return messages, calls

    def test_team_email_first_login_uses_password_totp_and_response_workspaces(self):
        messages, calls = self.execute()
        self.assertEqual(messages[-1]["event"], "complete")
        self.assertTrue(any(u.endswith("/workspace/select") for _, _, u, _ in calls))

    def test_team_reauth_selects_original_workspace_instead_of_first(self):
        messages, calls = self.execute(mode="reauth", target="personal-workspace", verify_original=True)
        self.assertEqual(messages[-1]["event"], "original_workspace")
        selected = [kw["json"] for _, _, u, kw in calls if u.endswith("/workspace/select")]
        self.assertEqual(selected, [{"workspace_id": "personal-workspace"}])

    def test_missing_original_workspace_keeps_choices_and_stops_without_selection(self):
        messages, calls = self.execute(mode="reauth", target="missing-workspace", workspaces=[
            {"id": "team-workspace", "name": "Example Team", "kind": "organization"},
            {"id": "personal-workspace", "kind": "personal", "plan_type": "plus"},
        ])
        self.assertEqual(messages[-1]["code"], "workspace")
        self.assertEqual(messages[-1]["workspaces"][0], {"id": "team-workspace", "name": "Example Team"})
        self.assertFalse(any(u.endswith("/workspace/select") for _, _, u, _ in calls))

    def test_plus_and_pro_direct_callback_without_workspace_ignores_stale_cookie(self):
        for plan in ["plus", "pro"]:
            with self.subTest(plan=plan):
                messages, calls = self.execute(plan=plan)
                self.assertEqual(messages[-1]["event"], "complete")
                self.assertFalse(any(u.endswith("/workspace/select") for _, _, u, _ in calls))

    def test_password_totp_direct_callback_reauth_does_not_restart_authorization(self):
        for plan in ['plus', 'pro']:
            messages, calls = self.execute(plan=plan, mode='reauth', target='personal-workspace', workspaces=[], verify_original=True)
            self.assertEqual(messages[-1]['event'], 'original_workspace')
            self.assertEqual(messages[-1]['workspaceId'], 'personal-workspace')
            self.assertEqual(sum(urlsplit(url).path == '/oauth/authorize' for _, _, url, _ in calls), 1)
            self.assertEqual(sum(u.endswith('/password/verify') for _, _, u, _ in calls), 1)
            self.assertEqual(sum(u.endswith('/mfa/verify') for _, _, u, _ in calls), 1)
            self.assertEqual(sum(u.endswith('/oauth/token') for _, _, u, _ in calls), 1)
            self.assertNotIn('private-fresh-refresh', json.dumps(messages[:-1]))

    def test_password_totp_direct_callback_rejects_token_for_other_workspace(self):
        messages, calls = self.execute(plan='plus', mode='reauth', target='personal-workspace', workspaces=[], verify_original=True, token_workspace='other-workspace')
        self.assertEqual(messages[-1], {'event': 'error', 'code': 'fallback_identity'})
        self.assertEqual(sum(u.endswith('/oauth/token') for _, _, u, _ in calls), 1)

    def test_password_totp_direct_callback_reauth_rejects_wrong_state_before_exchange(self):
        messages, calls = self.execute(plan='plus', mode='reauth', target='personal-workspace', workspaces=[], verify_original=True, state='wrong')
        self.assertEqual(messages[-1]['event'], 'error')
        self.assertFalse(any(url.endswith('/oauth/token') for _, _, url, _ in calls))

    def test_personal_reauth_still_requires_original_workspace_proof(self):
        messages, _ = self.execute(plan="plus", mode="reauth", target="personal-workspace", workspaces=[{"id": "personal-workspace"}])
        self.assertEqual(messages[-1]["event"], "complete")
        messages, _ = self.execute(plan="plus", mode="reauth", target="missing-workspace", workspaces=[])
        self.assertFalse(any(m["event"] == "complete" for m in messages))

    def test_both_flows_reject_wrong_state_without_exchanging_tokens(self):
        for plan in ["team", "plus"]:
            messages, calls = self.execute(plan=plan, state="wrong")
            self.assertFalse(any(m["event"] == "complete" for m in messages))
            self.assertFalse(any(u.endswith("/oauth/token") for _, _, u, _ in calls))

    def test_response_identity_mismatch_stops_before_password_and_workspace_selection(self):
        messages, calls = self.execute(session_email="other@example.com")
        self.assertEqual(messages[-1]["code"], "fallback_identity")
        self.assertFalse(any(u.endswith(("/password/verify", "/workspace/select")) for _, _, u, _ in calls))

    def test_password_and_mfa_failures_stop_without_otp_fallback_or_replay(self):
        for args in [{"password_status": 401}, {"password_status": 429}, {"mfa_status": 403}, {"mfa_status": 429}]:
            messages, calls = self.execute(**args)
            self.assertFalse(any(m["event"] == "complete" for m in messages))
            self.assertFalse(any(u.endswith("/workspace/select") for _, _, u, _ in calls))

    def test_initial_email_verification_page_also_selects_password(self):
        messages, calls = self.execute(landing="/email-verification")
        self.assertEqual(messages[-1]["event"], "complete")
        self.assertFalse(any(u.endswith("/authorize/continue") for _, _, u, _ in calls))

    def test_team_desktop_entry_redirect_loop_preserves_original_authorization(self):
        messages, calls = self.execute(bounce=True)
        self.assertEqual(messages[-1]["event"], "complete")
        self.assertEqual(sum(u == URL for _, _, u, _ in calls), 2)
        self.assertEqual(sum(u == desktop_url() for _, _, u, _ in calls), 1)


if __name__ == "__main__":
    unittest.main()
