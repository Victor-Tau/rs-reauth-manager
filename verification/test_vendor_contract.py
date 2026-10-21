"""Exercise the unmodified upstream OAuth implementation with an offline HTTP transport."""
import json
import socket
import sys
import types
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "protocol"))
import runner
from test_protocol import EMAIL, SECRET, URL, desktop_url
from requests.cookies import RequestsCookieJar
from vendor.lib import chatgpt_client, oauth_client


class OfflineSession:
    def __init__(self, requests, state, workspace, consent_page=False):
        self.headers = {}
        self.cookies = RequestsCookieJar()
        if workspace is not None:
            self.cookies.set("oai-client-auth-session", json.dumps({"workspace_id": workspace}), domain="auth.openai.com")
        self.requests = requests
        self.state = state
        self.consent_page = consent_page

    def request(self, method, url, **kwargs):
        callback = f"http://127.0.0.1:1455/auth/callback?state={self.state}&code=fixture-code"
        consent_url = "https://auth.openai.com/sign-in-with-chatgpt/codex/consent"
        if method == "POST" and self.consent_page == "hydration" and url.endswith('/api/accounts/workspace/select'):
            assert kwargs['json'] == {'workspace_id':'personal-workspace'}
            self.requests.append((method, url))
            return types.SimpleNamespace(status_code=302, url=url, headers={'Location':callback}, text='')
        if method != "GET" or url != URL:
            raise AssertionError("Unexpected offline transport request")
        self.requests.append((method, url))
        if self.consent_page == 'hydration':
            payload = '[{"_1":2},"workspaces",[3],{"_4":5},"id","personal-workspace"]'
            return types.SimpleNamespace(status_code=200, url=consent_url, headers={'Content-Type':'text/html'}, text='<script>window.__reactRouterContext.streamController.enqueue(' + json.dumps(payload) + ');</script>')
        if self.consent_page == 'empty':
            return types.SimpleNamespace(status_code=200, url=consent_url, headers={'Content-Type':'text/html'}, text='<div>fixture-password private-response</div>')
        if self.consent_page:
            return types.SimpleNamespace(status_code=200, url="https://auth.openai.com/sign-in-with-chatgpt/codex/consent", headers={"Content-Type": "text/html"}, text='<script>' + json.dumps({"continue_url": callback}) + '</script>')
        return types.SimpleNamespace(status_code=302, url=url, headers={"Location": callback}, text="")

    def close(self):
        pass


class VendorContractTests(unittest.TestCase):
    def mfa_failure(self, issue_status, verify_status=200):
        messages = []
        data = {'notes': f'{EMAIL}----fixture-password----{SECRET}', 'email': EMAIL, 'proxy': 'http://fixture:pass@127.0.0.1:21001', 'authorizationUrl': URL, 'accountId': 'original-workspace'}
        class Session:
            def __init__(self):
                self.cookies = RequestsCookieJar()
                self.headers = {}
            def close(self):
                pass
            def request(self, method, url, **kwargs):
                if method == 'GET' and url == URL:
                    return types.SimpleNamespace(status_code=302, url=url, headers={'Location':'https://auth.openai.com/mfa-challenge/fixture-factor'}, text='')
                assert method == 'POST'
                assert url in {'https://auth.openai.com/api/accounts/mfa/issue_challenge', 'https://auth.openai.com/api/accounts/mfa/verify'}
                status = issue_status if url.endswith('issue_challenge') else verify_status
                body = {} if status == 200 else {'error': {'code': 'unknown-upstream-code', 'message': 'private-body fixture-password'}}
                return types.SimpleNamespace(status_code=status, url=url, headers={}, text=json.dumps(body), json=lambda:body)
        with patch.object(chatgpt_client, 'create_http_session', side_effect=lambda **kwargs: Session()), patch.object(oauth_client, 'create_http_session', side_effect=lambda **kwargs: Session()), patch.object(oauth_client.OAuthClient, '_resolve_totp_factor', return_value={'id':'fixture-factor', 'factor_type':'totp'}), patch.object(oauth_client.OAuthClient, '_visit_oauth_page'), patch.object(socket, 'create_connection', side_effect=AssertionError('Network forbidden')), patch.object(runner, 'emit', side_effect=lambda event, **fields:messages.append({'event':event, **fields})):
            runner.run(data)
        return messages

    def test_real_mfa_issue_failure_retains_stage_and_status_without_raw_body(self):
        messages = self.mfa_failure(403)
        self.assertEqual(messages[-1]['diagnostic'], {'stage':'mfa_issue', 'reason':'mfa_issue_failed', 'httpStatus':403})
        self.assertNotIn('fixture-password', json.dumps(messages))
        self.assertNotIn('private-body', json.dumps(messages))

    def test_real_mfa_verify_rate_limit_is_not_wrong_secret(self):
        messages = self.mfa_failure(200, 429)
        self.assertEqual(messages[-1]['code'], 'limited')
        self.assertEqual(messages[-1]['diagnostic'], {'stage':'mfa_verify', 'reason':'rate_limited', 'httpStatus':429})

    def execute(self, url, state="fixture", workspace="original-workspace", importing=False, consent_page=False):
        self.messages, self.requests = [], []
        data = {"notes": f"{EMAIL}----fixture-password----{SECRET}", "email": EMAIL, "proxy": "http://fixture:pass@127.0.0.1:21001", "authorizationUrl": url, "accountId": "original-workspace"}
        if importing:
            data.update(mode="import", accountId="")

        def session(**kwargs):
            self.assertEqual(kwargs["proxy"], data["proxy"])
            return OfflineSession(self.requests, state, workspace, consent_page)

        with patch.object(chatgpt_client, "create_http_session", side_effect=session), patch.object(oauth_client, "create_http_session", side_effect=session), patch.object(socket, "create_connection", side_effect=AssertionError("Network forbidden")), patch.object(runner, "emit", side_effect=lambda event, **fields: self.messages.append({"event": event, **fields})):
            runner.run(data)

    def test_rs_wrapper_through_real_upstream_redirect_and_callback(self):
        self.execute(desktop_url())
        self.assertEqual(self.requests, [("GET", URL)])
        self.assertEqual(self.messages[-1], {"event": "complete", "callbackUrl": "http://127.0.0.1:1455/auth/callback?state=fixture&code=fixture-code"})
        self.assertNotIn("fixture-code", json.dumps(self.messages[:-1]))

    def test_direct_url_still_uses_real_upstream(self):
        self.execute(URL)
        self.assertEqual(self.requests, [("GET", URL)])
        self.assertEqual(self.messages[-1]["event"], "complete")

    def test_personal_import_callback_without_workspace_cookie(self):
        self.execute(desktop_url(), workspace=None, importing=True)
        self.assertEqual(self.requests, [("GET", URL)])
        self.assertEqual(self.messages[-1]["event"], "complete")

    def test_personal_import_consent_continues_without_workspace_metadata(self):
        self.execute(desktop_url(), workspace=None, importing=True, consent_page=True)
        self.assertEqual(self.requests, [("GET", URL)])
        self.assertEqual(self.messages[-1]["event"], "complete")

    def test_personal_import_without_workspace_still_rejects_wrong_state(self):
        self.execute(desktop_url(), state="wrong", workspace=None, importing=True)
        self.assertFalse(any(message["event"] == "complete" for message in self.messages))

    def test_personal_import_reads_workspace_from_indexed_hydration(self):
        self.execute(desktop_url(), workspace=None, importing=True, consent_page='hydration')
        self.assertEqual(self.requests[-1], ('POST', 'https://auth.openai.com/api/accounts/workspace/select'))
        self.assertEqual(self.messages[-1]['event'], 'complete')

    def test_unknown_consent_page_reports_page_features_without_raw_body(self):
        self.execute(desktop_url(), workspace=None, importing=True, consent_page='empty')
        self.assertEqual(len(self.requests), 1)
        self.assertEqual(self.messages[-1]['diagnostic']['reason'], 'callback_missing')
        logs = [m['entry'] for m in self.messages if m['event'] == 'diagnostic']
        self.assertIn({'action':'workspace_candidates', 'stage':'workspace', 'source':'page', 'count':0}, logs)
        self.assertTrue(any(entry.get('pageType') == 'consent' and entry.get('httpStatus') == 200 for entry in logs))
        self.assertNotIn('private-response', json.dumps(self.messages))

    def test_explicit_workspace_is_required_even_when_callback_has_no_cookie(self):
        self.execute(desktop_url(), workspace=None)
        self.assertEqual(self.messages[-1]["code"], "workspace")

    def test_real_upstream_rejects_wrong_callback_state(self):
        self.execute(desktop_url(), state="wrong")
        self.assertFalse(any(message["event"] == "complete" for message in self.messages))
        self.assertEqual(self.messages[-1]["event"], "error")

    def test_real_upstream_cookie_cannot_select_different_workspace(self):
        self.execute(desktop_url(), workspace="other-workspace")
        self.assertEqual(self.messages[-1], {"event": "error", "code": "workspace", "workspaces": [{"id": "other-workspace"}]})
        self.assertFalse(any(message["event"] == "complete" for message in self.messages))


if __name__ == "__main__":
    unittest.main()
