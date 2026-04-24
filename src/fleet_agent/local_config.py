"""Host-local per-phone config shared with the Rust server."""

import json
import logging
import os

log = logging.getLogger('fleet-agent')

LOCAL_CONFIG_PATH = os.environ.get(
    'LOCAL_PHONE_CONFIG',
    '/data/otacon/local_config.json',
)


def wifi_enabled(serial: str) -> bool:
    """Return whether fleet-agent should manage Wi-Fi for this serial."""
    try:
        with open(LOCAL_CONFIG_PATH, 'r', encoding='utf-8') as f:
            data = json.load(f)
        cfg = data.get(serial)
        if isinstance(cfg, dict) and isinstance(cfg.get('wifi_enabled'), bool):
            return cfg['wifi_enabled']
    except FileNotFoundError:
        return True
    except Exception as e:
        log.warning(f'Could not read local config {LOCAL_CONFIG_PATH}: {e}')
    return True
