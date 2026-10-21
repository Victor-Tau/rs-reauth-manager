"""Read explicit workspace data from JSON and streamed consent-page hydration."""
import html
import json
import re


def workspace_ids(text):
    text = html.unescape(str(text or ""))[:2_000_000]
    ids = []

    def remember(value):
        if isinstance(value, str) and re.fullmatch(r"[A-Za-z0-9_-]{1,128}", value) and value not in ids:
            ids.append(value)

    def inspect(value, pool=None, depth=0):
        if depth > 20:
            return
        if isinstance(value, dict):
            for key, child in value.items():
                # React Router hydration uses indexed keys and values
                if pool is not None and re.fullmatch(r"_\d+", key):
                    index = int(key[1:])
                    key = pool[index] if index < len(pool) else ""
                if key in {"workspace_id", "workspaceId"}:
                    remember(pool[child] if pool is not None and type(child) is int and 0 <= child < len(pool) else child)
                if key == "workspaces":
                    rows = pool[child] if pool is not None and type(child) is int and 0 <= child < len(pool) else child
                    if isinstance(rows, list):
                        for row in rows:
                            row = pool[row] if pool is not None and type(row) is int and 0 <= row < len(pool) else row
                            if isinstance(row, dict):
                                for field, item in row.items():
                                    if pool is not None and re.fullmatch(r"_\d+", field):
                                        index = int(field[1:])
                                        field = pool[index] if index < len(pool) else ""
                                    if field == "id":
                                        remember(pool[item] if pool is not None and type(item) is int and 0 <= item < len(pool) else item)
                inspect(child, pool, depth + 1)
        elif isinstance(value, list):
            for child in value[:10000]:
                inspect(child, pool, depth + 1)

    # A script may carry JSON directly or a JSON string passed to enqueue
    decoder = json.JSONDecoder()
    candidates = [text]
    candidates.extend(re.findall(r"<script\b[^>]*>(.*?)</script>", text, re.I | re.S))
    for match in re.finditer(r"(?:enqueue|push)\s*\(\s*", text):
        try:
            value, _ = decoder.raw_decode(text[match.end():])
            if isinstance(value, str):
                candidates.append(value)
        except (ValueError, RecursionError):
            pass
    for candidate in candidates[:64]:
        try:
            value = json.loads(candidate)
            inspect(value, value if isinstance(value, list) else None)
        except (ValueError, RecursionError, TypeError):
            pass
    decoded = text.replace('\\"', '"')
    for value in re.findall(r'(?i)(?:workspace_id|workspaceId)[^A-Za-z0-9_-]{0,8}([A-Za-z0-9_-]{8,128})', decoded):
        remember(value)
    # Older streamed pages contain a string table rather than indexed objects
    for section in re.findall(r'"workspaces"(.{0,1600}?)(?:</script>|$)', decoded, re.I | re.S):
        for value in re.findall(r'"id"\s*,\s*"([0-9a-fA-F-]{36})"', section):
            remember(value)
    return ids[:31]

