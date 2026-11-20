"""Capture only public request metadata for interactive email-change diagnostics."""
import time

from diagnostics import stage_for_url, transport_reason


class EmailTrace:
    def __init__(self, session, emit):
        self.last = {}
        self.failure = None
        self.emit = lambda event, **fields: emit('diagnostic', entry=fields)
        self.request = session.request
        session.request = self.traced_request

    def traced_request(self, method, url, **kwargs):
        stage = stage_for_url(url)
        attempt = {'stage': stage, 'httpStatus': None}
        self.last = attempt
        started = time.monotonic()
        self.emit('trace', action='request', stage=stage, method=method.upper())
        try:
            response = self.request(method, url, **kwargs)
        except Exception as exc:
            attempt['transport'] = transport_reason(exc)
            self.failure = attempt
            self.emit('trace', action='transport', stage=stage, reason=attempt['transport'],
                      elapsedMs=int((time.monotonic() - started) * 1000))
            raise
        attempt['httpStatus'] = response.status_code
        if response.status_code >= 400:
            self.failure = attempt
        headers = getattr(response, 'headers', {})
        content_type = headers.get('Content-Type', '').split(';')[0].strip().lower()
        text = getattr(response, 'text', '') or ''
        self.emit('trace', action='response', stage=stage, method=method.upper(),
                  httpStatus=response.status_code, elapsedMs=int((time.monotonic() - started) * 1000),
                  responseBytes=len(text.encode('utf-8')), contentType=content_type if content_type in {'application/json', 'text/html', 'text/plain'} else '',
                  redirect=bool(headers.get('Location')))
        return response

    def diagnostic(self, error=None):
        from diagnostics import describe_failure
        return describe_failure({'error': error}, attempt=self.failure or self.last)['diagnostic']
