"""Registry HTTP client — talks to the central registry."""

import logging
import os

from ..util.http import http_post

log = logging.getLogger('fleet-agent')


def register_with_registry(identity: dict, adapter_mac: str | None = None,
                            registry_id: str | None = None) -> tuple[str | None, dict | None]:
    """Report this phone to the central registry.

    Returns (registry_id, config) or (None, None).
    """
    registry_url = os.environ.get('REGISTRY_URL')
    if not registry_url:
        return (None, None)
    host_id = os.environ.get('HOST_ID', '')
    payload = {
        'host_id': host_id,
        **identity,
    }
    if adapter_mac:
        payload['adapter_mac'] = adapter_mac
    result = http_post(f'{registry_url}/api/v1/phones/register', payload)
    if result:
        rid = result.get('phone_id')
        log.info(f'Registered with registry as {rid}')
        return (rid, result.get('config'))
    return (None, None)


def deregister_from_registry(registry_id: str | None):
    registry_url = os.environ.get('REGISTRY_URL')
    if not registry_url or not registry_id:
        return
    host_id = os.environ.get('HOST_ID', '')
    http_post(f'{registry_url}/api/v1/phones/deregister', {
        'host_id': host_id,
        'phone_id': registry_id,
    })
    log.info(f'Deregistered {registry_id} from registry')


def report_error(category: str, message: str, phone_id: str | None = None,
                  data: dict | None = None):
    """Report an error to the registry (fire and forget)."""
    registry_url = os.environ.get('REGISTRY_URL')
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
    http_post(f'{registry_url}/api/v1/events', payload)
    log.error(f'[{category}] {message}')
