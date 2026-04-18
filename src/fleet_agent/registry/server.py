"""Registration with the local Rust server."""

import logging
import os

from urllib.request import Request, urlopen
from urllib.error import URLError

from ..util.http import http_post

log = logging.getLogger('fleet-agent')

RUST_SERVER_URL = os.environ.get('RUST_SERVER_URL',
    f'http://127.0.0.1:{os.environ.get("INTERNAL_PORT", "8081")}')


def register_with_server(serial: str, snapshot_port: int, internal_port: int,
                          adapter_mac: str | None = None,
                          phone_bt_mac: str | None = None) -> str | None:
    """Register this phone with the local Rust server. Returns phone_id."""
    payload = {
        'adb_serial': serial,
        'snapshot_port': snapshot_port,
        'internal_port': internal_port,
    }
    if adapter_mac:
        payload['adapter_mac'] = adapter_mac
    if phone_bt_mac:
        payload['phone_bt_mac'] = phone_bt_mac
    result = http_post(f'{RUST_SERVER_URL}/phones', payload)
    if result:
        phone_id = result.get('id')
        log.info(f'[{serial}] Registered with Rust server as {phone_id}')
        return phone_id
    return None


def deregister_from_server(phone_id: str | None):
    if not phone_id:
        return
    try:
        req = Request(f'{RUST_SERVER_URL}/phones/{phone_id}', method='DELETE')
        urlopen(req, timeout=5)
        log.info(f'Deregistered {phone_id} from Rust server')
    except (URLError, OSError, TimeoutError):
        pass
