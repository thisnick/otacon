import logging
import os

from ..util.adb import adb_shell

log = logging.getLogger('fleet-agent')


def connect_wifi(serial: str):
    ssid = os.environ.get('WIFI_AP_SSID', '')
    password = os.environ.get('WIFI_AP_PASSWORD', '')
    if not ssid:
        return

    log.info(f"[{serial}] Connecting WiFi '{ssid}' (hidden AP)...")
    result = adb_shell(
        serial,
        f'cmd wifi connect-network "{ssid}" wpa2 "{password}" -h'
    )
    if result and 'successful' in result.lower():
        log.info(f'[{serial}] WiFi connect requested via cmd wifi -h')
    elif not result:
        adb_shell(
            serial,
            f"content query --uri 'content://com.otacon.kiosk/wifi/connect?ssid={ssid}&password={password}'"
        )
