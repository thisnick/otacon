"""Registry HTTP client — talks to the central registry."""

import json
import logging
import os
import time

from urllib.error import URLError, HTTPError
from urllib.request import Request, urlopen

from ..util.auth import load_token, save_token, clear_token

log = logging.getLogger('fleet-agent')


def _get_registry_url() -> str | None:
    return os.environ.get('REGISTRY_URL')


def _auth_headers() -> dict:
    """Return Authorization header if a token is available."""
    token = load_token()
    if token:
        return {'Authorization': f'Bearer {token}'}
    return {}


def _http_post(url: str, data: dict, timeout: int = 5,
               headers: dict | None = None) -> dict | None:
    """POST JSON with optional auth headers. Returns parsed response or None."""
    all_headers = {'Content-Type': 'application/json'}
    all_headers.update(_auth_headers())
    if headers:
        all_headers.update(headers)
    try:
        req = Request(url, data=json.dumps(data).encode(), headers=all_headers)
        with urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode())
    except HTTPError as e:
        if e.code == 401:
            log.error(f'Auth token revoked or invalid (401 from {url})')
            clear_token()
            raise
        raise
    except (URLError, OSError, TimeoutError, json.JSONDecodeError):
        return None


def _http_get(url: str, timeout: int = 5) -> dict | str | None:
    """GET with optional auth headers."""
    headers = _auth_headers()
    try:
        req = Request(url, headers=headers)
        with urlopen(req, timeout=timeout) as resp:
            body = resp.read().decode()
            try:
                return json.loads(body)
            except json.JSONDecodeError:
                return body
    except (URLError, OSError, TimeoutError):
        return None


def ensure_registered() -> bool:
    """Ensure this node is registered and has a valid auth token.

    If no token exists, initiates the registration flow:
    1. POST /api/v1/hosts/register
    2. Long-poll /api/v1/hosts/poll/{pending_id} until approved
    3. Save token to disk

    Returns True if a valid token is available (existing or newly obtained).
    """
    token = load_token()
    if token:
        return True

    registry_url = _get_registry_url()
    if not registry_url:
        return False

    host_id = os.environ.get('HOST_ID', '')
    hostname = os.environ.get('HOSTNAME', '')

    log.info('No auth token found — starting registration flow')

    # Step 1: Register
    try:
        req = Request(
            f'{registry_url}/api/v1/hosts/register',
            data=json.dumps({
                'host_id': host_id,
                'hostname': hostname,
            }).encode(),
            headers={'Content-Type': 'application/json'},
        )
        with urlopen(req, timeout=10) as resp:
            result = json.loads(resp.read().decode())
    except (URLError, OSError, TimeoutError, json.JSONDecodeError) as e:
        log.error(f'Registration request failed: {e}')
        return False

    pending_id = result.get('pending_id')
    if not pending_id:
        log.error('Registration response missing pending_id')
        return False

    poll_url = f'{registry_url}/api/v1/hosts/poll/{pending_id}'
    log.info(f'Registration pending (id={pending_id}). Waiting for admin approval...')

    # Step 2: Long-poll until approved or rejected
    while True:
        try:
            req = Request(
                poll_url,
                data=b'{}',
                headers={'Content-Type': 'application/json'},
                method='POST',
            )
            with urlopen(req, timeout=310) as resp:  # slightly > server 5min timeout
                poll_result = json.loads(resp.read().decode())
                raw_token = poll_result.get('token')
                if raw_token:
                    save_token(raw_token)
                    log.info('Registration approved — token saved')
                    return True
        except HTTPError as e:
            if e.code == 403:
                log.error('Registration REJECTED by admin. Will retry in 60s.')
                time.sleep(60)
                return False  # Let caller decide to retry
            elif e.code == 408:
                # Timeout — retry poll
                log.info('Poll timeout, retrying...')
                continue
            else:
                log.error(f'Poll error (HTTP {e.code}), retrying in 10s')
                time.sleep(10)
        except (URLError, OSError, TimeoutError) as e:
            log.error(f'Poll connection error: {e}, retrying in 10s')
            time.sleep(10)


def register_with_registry(identity: dict, adapter_mac: str | None = None,
                            registry_id: str | None = None) -> tuple[str | None, dict | None]:
    """Report this phone to the central registry.

    Returns (registry_id, config) or (None, None).
    """
    registry_url = _get_registry_url()
    if not registry_url:
        return (None, None)
    host_id = os.environ.get('HOST_ID', '')
    payload = {
        'host_id': host_id,
        **identity,
    }
    if adapter_mac:
        payload['adapter_mac'] = adapter_mac
    try:
        result = _http_post(f'{registry_url}/api/v1/hosts/phones/register', payload)
    except HTTPError:
        return (None, None)
    if result:
        rid = result.get('phone_id')
        log.info(f'Registered with registry as {rid}')
        return (rid, result.get('config'))
    return (None, None)


def deregister_from_registry(registry_id: str | None):
    registry_url = _get_registry_url()
    if not registry_url or not registry_id:
        return
    host_id = os.environ.get('HOST_ID', '')
    try:
        _http_post(f'{registry_url}/api/v1/hosts/phones/deregister', {
            'host_id': host_id,
            'phone_id': registry_id,
        })
    except HTTPError:
        pass
    log.info(f'Deregistered {registry_id} from registry')


def report_error(category: str, message: str, phone_id: str | None = None,
                  data: dict | None = None):
    """Report an error to the registry (fire and forget)."""
    registry_url = _get_registry_url()
    if not registry_url:
        log.error(f'[{category}] {message}')
        return
    host_id = os.environ.get('HOST_ID', '')
    payload = {
        'host_id': host_id,
        'phone_id': phone_id,
        'severity': 'error',
        'category': category,
        'message': message,
    }
    if data:
        payload['data'] = data
    try:
        _http_post(f'{registry_url}/api/v1/hosts/events', payload)
    except HTTPError:
        pass
    log.error(f'[{category}] {message}')


def update_registry_dongle(adapter_mac: str, phone_id: str | None) -> None:
    """Update a dongle's phone_id in the registry."""
    registry_url = _get_registry_url()
    if not registry_url:
        return
    host_id = os.environ.get('HOST_ID', '')
    try:
        _http_post(f'{registry_url}/api/v1/hosts/dongles/register', {
            'host_id': host_id,
            'dongles': [{
                'bt_mac': adapter_mac,
                'phone_id': phone_id,
            }],
        })
    except HTTPError:
        pass
    log.info(f'Updated registry dongle {adapter_mac} -> phone_id={phone_id}')


def emit_event(event_type: str, data: dict | None = None) -> None:
    """Emit a fleet event to the registry (fire and forget)."""
    registry_url = _get_registry_url()
    if not registry_url:
        log.info(f'[event] {event_type}: {data}')
        return
    host_id = os.environ.get('HOST_ID', '')
    phone_id = data.get('phone_id') if data else None
    payload = {
        'host_id': host_id,
        'phone_id': phone_id,
        'severity': 'info',
        'category': event_type,
        'message': f'{event_type} event',
    }
    if data:
        payload['data'] = data
    try:
        _http_post(f'{registry_url}/api/v1/hosts/events', payload)
    except HTTPError:
        pass
    log.info(f'[event] {event_type}: {data}')
