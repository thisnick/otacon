import json
from urllib.error import URLError
from urllib.request import Request, urlopen


def http_get(url: str, timeout: int = 5) -> dict | str | None:
    try:
        with urlopen(url, timeout=timeout) as resp:
            body = resp.read().decode()
            try:
                return json.loads(body)
            except json.JSONDecodeError:
                return body
    except (URLError, OSError, TimeoutError):
        return None


def http_post(url: str, data: dict, timeout: int = 5) -> dict | None:
    try:
        req = Request(url, data=json.dumps(data).encode(),
                      headers={'Content-Type': 'application/json'})
        with urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode())
    except (URLError, OSError, TimeoutError, json.JSONDecodeError):
        return None
