#!/usr/bin/env python3
"""Device monitor daemon — watches for ADB device connect/disconnect.

On each new connection:
  1. Configure screen settings (stay awake, brightness)
  2. Provision device owner if needed (or update APK)
  3. Start snapshot server (app_process)
  4. Set up ADB port forwards
  5. Connect WiFi via device owner app
  6. Apply kiosk restrictions
  7. Pair Bluetooth (auto-tap Samsung pairing dialog)
  8. Monitor connection — loop back on disconnect
"""

import json
import logging
import os
import re
import subprocess
import threading
import time
from urllib.error import URLError
from urllib.request import Request, urlopen

logging.basicConfig(
    format='%(asctime)s device-monitor: %(message)s',
    datefmt='%H:%M:%S',
    level=logging.INFO,
)
log = logging.getLogger('device-monitor')

DEVICE_OWNER_PKG = 'com.otacon.kiosk'
DEVICE_OWNER_RECEIVER = f'{DEVICE_OWNER_PKG}/.DeviceOwnerReceiver'
DEVICE_OWNER_URL = 'http://127.0.0.1:9090'
SNAPSHOT_URL = 'http://127.0.0.1:9091'
APK_PATH = '/opt/otacon-kiosk.apk'
JAR_PATH = '/opt/snapshot-server.jar'


# --- Helpers ---

def adb(*args: str, timeout: int = 10) -> str:
    """Run an ADB command and return stdout. Returns '' on failure."""
    try:
        result = subprocess.run(
            ['adb', *args],
            capture_output=True, text=True, timeout=timeout,
        )
        return result.stdout.strip()
    except (subprocess.TimeoutExpired, FileNotFoundError):
        return ''


def adb_shell(cmd: str, timeout: int = 10) -> str:
    return adb('shell', cmd, timeout=timeout)


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


def wait_for_device() -> str:
    """Block until an ADB device is connected. Returns serial."""
    while True:
        output = adb('devices')
        for line in output.splitlines():
            if line.endswith('\tdevice'):
                return line.split('\t')[0]
        time.sleep(2)


def is_device_connected(serial: str) -> bool:
    """Check if device is connected, retry once on failure (ADB can hiccup briefly)."""
    state = adb('-s', serial, 'get-state')
    if state == 'device':
        return True
    # ADB can briefly disconnect during APK install — retry after a pause
    time.sleep(3)
    state = adb('-s', serial, 'get-state')
    return state == 'device'


def wait_for_server(url: str, name: str, retries: int = 10):
    for _ in range(retries):
        result = http_get(f'{url}/health', timeout=2)
        if isinstance(result, dict) and result.get('ok'):
            log.info(f'{name} connected')
            return True
        time.sleep(1)
    log.warning(f'{name} not available')
    return False


# --- Setup steps ---

def configure_screen():
    log.info('Configuring screen...')
    adb_shell('settings put global stay_on_while_plugged_in 2')
    adb_shell('settings put system screen_off_timeout 2147483647')
    adb_shell('settings put system screen_brightness_mode 0')
    adb_shell('settings put system screen_brightness 0')
    # Set PIN to 0000 via ADB (not device owner — that triggers Samsung sec.automation)
    result = adb_shell('locksettings set-pin 0000')
    if 'error' not in result.lower():
        log.info('PIN set to 0000')
    else:
        log.info(f'PIN already set or failed: {result}')
    adb_shell('svc data disable')
    # Disable RCS (Google Messages) — forces SMS-only, works with content://sms
    adb_shell('pm disable-user --user 0 com.google.android.apps.messaging')
    # Only wake if screen is off (keyevent 26 is a toggle)
    display_state = adb_shell('dumpsys display | grep "mScreenState"')
    if 'OFF' in display_state or 'mScreenState=0' in display_state:
        adb_shell('input keyevent 224')  # WAKEUP (not a toggle)
        time.sleep(0.5)
        adb_shell('input swipe 540 1800 540 800')  # dismiss lock


def is_device_owner_set() -> bool:
    output = adb_shell('dpm list-owners')
    return DEVICE_OWNER_PKG in output


def provision_device_owner():
    if is_device_owner_set():
        log.info('Device owner already set')
        # Update APK
        if os.path.exists(APK_PATH):
            result = adb('install', '-r', APK_PATH, timeout=30)
            if 'Success' in result:
                log.info('APK updated')
        # Grant runtime permissions that device owner needs
        adb_shell(f'pm grant {DEVICE_OWNER_PKG} android.permission.SEND_SMS')
        # Kick-start HTTP server (BootReceiver starts it on any broadcast)
        adb_shell(
            f'am broadcast -a {DEVICE_OWNER_PKG}.CLEAR_RESTRICTIONS '
            f'-n {DEVICE_OWNER_PKG}/.BootReceiver'
        )
        return

    log.info('Device owner not set — provisioning...')

    # Check for accounts
    account_dump = adb_shell('dumpsys account')
    account_count = account_dump.count('Account {')
    if account_count > 0:
        log.error(f'Phone has {account_count} account(s). Factory reset required.')
        return

    if not os.path.exists(APK_PATH):
        log.warning(f'{APK_PATH} not found — skipping')
        return

    adb('install', '-r', APK_PATH, timeout=30)
    adb_shell(f'dpm set-device-owner {DEVICE_OWNER_RECEIVER}')
    adb_shell(f'cmd notification allow_listener {DEVICE_OWNER_PKG}/.OtaconNotificationListener')
    adb_shell(f'pm grant {DEVICE_OWNER_PKG} android.permission.BLUETOOTH_CONNECT')
    adb_shell(f'pm grant {DEVICE_OWNER_PKG} android.permission.BLUETOOTH_SCAN')
    log.info('Device owner provisioned')


def start_snapshot_server():
    if not os.path.exists(JAR_PATH):
        log.warning(f'{JAR_PATH} not found — skipping')
        return

    adb('push', JAR_PATH, '/data/local/tmp/snapshot-server.jar', timeout=15)
    adb_shell('pkill -f snapshot-server.jar')
    time.sleep(1)
    adb_shell(
        'nohup app_process -Djava.class.path=/data/local/tmp/snapshot-server.jar '
        '/ com.otacon.snapshot.SnapshotServer > /dev/null 2>&1 &'
    )
    log.info('Snapshot server started')


def setup_port_forwards():
    adb('forward', 'tcp:9090', 'tcp:9090')
    adb('forward', 'tcp:9091', 'tcp:9091')
    log.info('Port forwards established')


def connect_wifi():
    ssid = os.environ.get('WIFI_AP_SSID', '')
    password = os.environ.get('WIFI_AP_PASSWORD', '')
    if not ssid:
        return

    log.info(f"Connecting WiFi '{ssid}'...")
    result = http_post(f'{DEVICE_OWNER_URL}/wifi/connect',
                       {'ssid': ssid, 'password': password}, timeout=10)
    if result and result.get('ok'):
        log.info(f"WiFi connected via bridge (method={result.get('method')})")
    else:
        # ADB fallback
        adb_shell(f'cmd wifi connect-network "{ssid}" wpa2 "{password}"')


def apply_restrictions():
    if not is_device_owner_set():
        return
    # Clear first to remove stale restrictions from previous versions
    adb_shell(
        f'am broadcast -a {DEVICE_OWNER_PKG}.CLEAR_RESTRICTIONS '
        f'-n {DEVICE_OWNER_PKG}/.BootReceiver'
    )
    time.sleep(1)
    adb_shell(
        f'am broadcast -a {DEVICE_OWNER_PKG}.APPLY_RESTRICTIONS '
        f'-n {DEVICE_OWNER_PKG}/.BootReceiver'
    )
    # Ensure notification listener is enabled
    adb_shell(f'cmd notification allow_listener {DEVICE_OWNER_PKG}/.OtaconNotificationListener')
    log.info('Restrictions applied')


def pair_bluetooth():
    if os.environ.get('AUDIO_BACKEND') != 'bluetooth':
        return

    # Get Pi's BT MAC
    try:
        output = subprocess.run(
            ['hciconfig', 'hci0'], capture_output=True, text=True, timeout=5,
        ).stdout
        match = re.search(r'BD Address: (\S+)', output)
        if not match:
            return
        pi_mac = match.group(1)
    except (subprocess.TimeoutExpired, FileNotFoundError):
        return

    log.info(f'Checking Bluetooth pairing with Pi ({pi_mac})...')

    # Get phone's BT MAC and remove any stale paired devices
    phone_bt_mac = adb_shell('settings get secure bluetooth_address').strip()
    if phone_bt_mac and phone_bt_mac != 'null':
        # List all paired devices and remove any that aren't the current phone
        try:
            paired = subprocess.run(
                ['bluetoothctl', 'devices'], capture_output=True, text=True, timeout=5,
            ).stdout
            for line in paired.splitlines():
                parts = line.split()
                if len(parts) >= 2:
                    mac = parts[1]
                    if mac.upper() != phone_bt_mac.upper():
                        log.info(f'Removing stale BT device: {mac}')
                        subprocess.run(['bluetoothctl', 'remove', mac], timeout=5,
                                       capture_output=True)
        except (subprocess.TimeoutExpired, FileNotFoundError):
            pass

    # Start pairing in background thread
    pair_result = {}
    pair_done = threading.Event()

    def do_pair():
        result = http_post(f'{DEVICE_OWNER_URL}/bluetooth/pair',
                           {'mac': pi_mac}, timeout=45)
        pair_result['data'] = result
        pair_done.set()

    pair_thread = threading.Thread(target=do_pair, daemon=True)
    pair_thread.start()

    # Auto-tap Samsung's pairing confirmation dialog.
    # Keep polling even after pair API returns — the dialog may appear after createBond().
    tapped = False
    for _ in range(30):
        time.sleep(1)
        ref = find_pair_button()
        if ref:
            log.info(f"Auto-tapping 'Pair' button ({ref})")
            http_post(f'{SNAPSHOT_URL}/action', {'action': 'click', 'ref': ref})
            tapped = True
            break

    pair_thread.join(timeout=10 if tapped else 30)
    result = pair_result.get('data') or {}
    status = result.get('status', result.get('error', 'unknown')) if isinstance(result, dict) else str(result)
    log.info(f'Bluetooth pairing: {status}')


def find_pair_button() -> str | None:
    """Search the snapshot tree for a clickable 'Pair' button."""
    data = http_get(f'{SNAPSHOT_URL}/snapshot?format=json', timeout=3)
    if not data:
        return None

    def walk(node):
        if node.get('text') == 'Pair' and node.get('clickable'):
            return node.get('ref_id')
        for child in node.get('children', []):
            ref = walk(child)
            if ref:
                return ref
        return None

    nodes = data if isinstance(data, list) else [data]
    for node in nodes:
        ref = walk(node)
        if ref:
            return ref
    return None


# --- Main loop ---

def main():
    last_serial = None

    while True:
        serial = wait_for_device()

        # Same device still connected — just monitor
        if serial == last_serial:
            if is_device_connected(serial):
                # Re-establish port forwards
                adb('forward', 'tcp:9090', 'tcp:9090')
                adb('forward', 'tcp:9091', 'tcp:9091')
                time.sleep(10)
                continue
            else:
                log.info(f'Device {last_serial} disconnected')
                last_serial = None
                continue

        log.info(f'New device connected: {serial}')
        last_serial = serial
        time.sleep(2)  # let device initialize

        configure_screen()
        provision_device_owner()
        start_snapshot_server()
        setup_port_forwards()
        wait_for_server(DEVICE_OWNER_URL, 'Device owner bridge', retries=60)
        wait_for_server(SNAPSHOT_URL, 'Snapshot server')
        connect_wifi()
        pair_bluetooth()
        apply_restrictions()

        log.info('Device setup complete')

        # Monitor connection + keep services alive
        while is_device_connected(serial):
            adb('forward', 'tcp:9090', 'tcp:9090')
            adb('forward', 'tcp:9091', 'tcp:9091')

            # Restart snapshot server if process died
            proc_check = adb_shell('pgrep -f snapshot-server.jar')
            if not proc_check.strip():
                log.warning('Snapshot server dead — restarting')
                start_snapshot_server()
                time.sleep(3)
                adb('forward', 'tcp:9091', 'tcp:9091')

            time.sleep(10)

        log.info(f'Device {serial} disconnected')
        last_serial = None
        time.sleep(2)


if __name__ == '__main__':
    main()
