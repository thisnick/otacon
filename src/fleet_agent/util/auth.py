"""Auth token storage helper for fleet-agent → registry communication."""

import json
import logging
import os
import stat

log = logging.getLogger('fleet-agent')

AUTH_FILE = os.environ.get('OTACON_AUTH_FILE', '/etc/otacon/auth.json')


def load_token() -> str | None:
    """Load the bearer token from disk. Returns None if not found."""
    try:
        with open(AUTH_FILE) as f:
            data = json.load(f)
            return data.get('token')
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return None


def save_token(token: str) -> None:
    """Persist the bearer token to disk with restrictive permissions."""
    os.makedirs(os.path.dirname(AUTH_FILE), exist_ok=True)
    with open(AUTH_FILE, 'w') as f:
        json.dump({'token': token}, f)
    # Mode 600 — owner read/write only
    os.chmod(AUTH_FILE, stat.S_IRUSR | stat.S_IWUSR)
    log.info(f'Auth token saved to {AUTH_FILE}')


def clear_token() -> None:
    """Remove the stored token (e.g. after revocation)."""
    try:
        os.remove(AUTH_FILE)
        log.info(f'Auth token removed from {AUTH_FILE}')
    except FileNotFoundError:
        pass
