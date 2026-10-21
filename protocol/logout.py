"""Replay the captured logout-all contract with the selected account's credentials."""
import re
import time
from urllib.parse import urlsplit

from vendor.lib.http_client import create_http_session

URL = "https://chatgpt.com/backend-api/accounts/logout_all"


def run_logout(data, emit):
    proxy = data.get("proxy")
    token = data.get("accessToken")
    account = data.get("accountId")
    if not isinstance(proxy, str) or urlsplit(proxy).scheme not in {"http", "https", "socks5", "socks5h"} or not urlsplit(proxy).hostname:
        emit("error", code="logout_credentials")
        return
    if not isinstance(token, str) or not token or len(token) > 16384 or any(ord(c) <= 32 or ord(c) == 127 for c in token) or not isinstance(account, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", account):
        emit("error", code="logout_credentials")
        return
    headers = {"Accept": "application/json", "Authorization": "Bearer " + token,
               "ChatGPT-Account-ID": account, "Origin": "https://chatgpt.com",
               "Referer": "https://chatgpt.com/settings/security"}
    cookies = data.get("cookies") or []
    if not isinstance(cookies, list) or len(cookies) > 100:
        emit("error", code="logout_credentials")
        return
    values = []
    for cookie in cookies:
        if not isinstance(cookie, dict):
            emit("error", code="logout_credentials")
            return
        name, value = cookie.get("name"), cookie.get("value")
        if not isinstance(name, str) or not re.fullmatch(r"[!#$%&'*+.^_`|~0-9A-Za-z-]+", name) or not isinstance(value, str) or not value or any(ord(c) < 32 or ord(c) == 127 or c == ';' for c in value):
            emit("error", code="logout_credentials")
            return
        values.append(name + "=" + value)
    if values:
        headers["Cookie"] = "; ".join(values)
        if len(headers["Cookie"]) > 32768:
            emit("error", code="logout_credentials")
            return
    session = None
    try:
        session = create_http_session(proxy=proxy, impersonate="chrome133a")
        # The requests fallback normally retries POST; logout must be sent only once
        import requests
        if isinstance(session, requests.Session):
            session.mount("https://", requests.adapters.HTTPAdapter(max_retries=0))
        emit("step", step="logout")
        started = time.monotonic()
        emit('diagnostic', entry={'action':'request', 'stage':'logout', 'method':'POST'})
        response = session.request("POST", URL, headers=headers, data=b"", allow_redirects=False, timeout=30)
        status = response.status_code
        emit('diagnostic', entry={'action':'response', 'stage':'logout', 'method':'POST', 'httpStatus':status, 'elapsedMs':int((time.monotonic() - started) * 1000)})
        if status == 200:
            if response.json() is None:
                emit("logout_complete")
            else:
                emit("error", code="logout_uncertain", httpStatus=200)
        elif status in {401, 403, 429}:
            emit("error", code="logout_rejected", httpStatus=status)
        else:
            emit("error", code="logout_uncertain", httpStatus=status if isinstance(status, int) and 100 <= status <= 599 else None)
    except Exception:
        emit("error", code="logout_uncertain")
    finally:
        if session is not None:
            session.close()
