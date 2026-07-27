"""rest-client module: policy-carrying outbound HTTP. See agent-guide."""
import json as _json
import time
import urllib.error
import urllib.request


class HttpError(Exception):
    def __init__(self, status, body=""):
        super().__init__(f"HTTP {status}")
        self.status = status
        self.body = body


def _default_transport(method, url, body, headers, timeout):
    req = urllib.request.Request(url, data=body, headers=headers, method=method)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.status, resp.read().decode("utf-8", errors="replace")


def request(method, url, json=None, headers=None, transport=None, retries=2, timeout=10, backoff=0.1, sleep=time.sleep):
    transport = transport or _default_transport
    body = _json.dumps(json).encode() if json is not None else None
    headers = {"Content-Type": "application/json", **(headers or {})}
    last = None
    for attempt in range(retries + 1):
        try:
            status, text = transport(method, url, body, headers, timeout)
            if status >= 500:
                last = HttpError(status, text)
            elif status >= 400:
                raise HttpError(status, text)
            else:
                return {"status": status, "text": text}
        except HttpError as e:
            if 400 <= e.status < 500:
                raise
            last = e
        except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
            last = e
        if attempt < retries:
            sleep(backoff * (2 ** attempt))
    raise last
