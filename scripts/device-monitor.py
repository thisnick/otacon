#!/usr/bin/env python3
"""Device monitor daemon — watches for ADB devices, manages multiple phones.

DeviceManager watches `adb devices` and spawns a PhoneMonitor per serial.
Each PhoneMonitor handles the full lifecycle for one phone:
  1. Configure screen settings (stay awake, brightness)
  2. Provision device owner if needed (or update APK)
  3. Start snapshot server (app_process)
  4. Set up ADB port forwards (per-phone ports)
  5. Connect WiFi via device owner app
  6. Apply kiosk restrictions
  7. Pair Bluetooth (auto-tap Samsung pairing dialog)
  8. Register with central registry (if REGISTRY_URL set)
  9. Monitor connection — clean up on disconnect
"""

import json
import logging
import os
import re
import socket
import subprocess
import threading
import time
import urllib.parse
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
APK_PATH = '/opt/otacon-kiosk.apk'
JAR_PATH = '/opt/snapshot-server.jar'

RUST_SERVER_URL = os.environ.get('RUST_SERVER_URL',
    f'http://127.0.0.1:{os.environ.get("INTERNAL_PORT", "8081")}')


# --- Helpers ---

def adb(serial: str, *args: str, timeout: int = 10) -> str:
    """Run an ADB command targeting a specific device serial."""
    try:
        result = subprocess.run(
            ['adb', '-s', serial, *args],
            capture_output=True, text=True, timeout=timeout,
        )
        return result.stdout.strip()
    except (subprocess.TimeoutExpired, FileNotFoundError):
        return ''


def adb_shell(serial: str, cmd: str, timeout: int = 10) -> str:
    return adb(serial, 'shell', cmd, timeout=timeout)


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


def get_connected_serials() -> set[str]:
    """Return set of currently connected ADB device serials."""
    try:
        result = subprocess.run(
            ['adb', 'devices'], capture_output=True, text=True, timeout=5,
        )
        serials = set()
        for line in result.stdout.splitlines():
            if line.endswith('\tdevice'):
                serials.add(line.split('\t')[0])
        return serials
    except (subprocess.TimeoutExpired, FileNotFoundError):
        return set()


RUNTIME_PERMISSIONS = [
    'android.permission.BLUETOOTH_CONNECT',
    'android.permission.BLUETOOTH_SCAN',
    'android.permission.SEND_SMS',
    'android.permission.READ_SMS',
    'android.permission.RECEIVE_SMS',
    'android.permission.READ_PHONE_STATE',
    'android.permission.CALL_PHONE',
    'android.permission.ANSWER_PHONE_CALLS',
    'android.permission.READ_CALL_LOG',
]

PHONES_JSON_PATH = os.environ.get('PHONES_CONFIG', '/data/otacon/phones.json')


# --- Dongle allocator ---

def enum_dongles() -> dict[str, str]:
    """Enumerate all HCI adapters. Returns {bt_mac: hci_name}."""
    dongles = {}
    try:
        result = subprocess.run(
            ['hciconfig'], capture_output=True, text=True, timeout=5,
        )
        current_hci = None
        for raw_line in result.stdout.splitlines():
            stripped = raw_line.strip()
            if not stripped:
                continue
            # BD Address lines are indented; check them first to avoid
            # misidentifying them as hci header lines after stripping.
            if 'BD Address:' in stripped and current_hci:
                mac = stripped.split('BD Address:')[1].strip().split()[0]
                if mac and mac != '00:00:00:00:00:00':
                    dongles[mac.upper()] = current_hci
                current_hci = None
            elif not raw_line[0].isspace() and ':' in stripped:
                # Header line like "hci0:   Type: Primary  Bus: USB"
                current_hci = stripped.split(':')[0]
    except (subprocess.TimeoutExpired, FileNotFoundError):
        pass
    return dongles


_dongle_lock = threading.Lock()
# In-memory authoritative cache of dongle assignments: {serial: adapter_mac}.
# Protected by _dongle_lock.  Seeded from phones.json on first access,
# then kept consistent in-process.  This avoids TOCTOU races between
# device-monitor threads AND the Rust server writing to phones.json.
_dongle_cache: dict[str, str] | None = None
# Parallel cache for phone_bt_mac: {serial: phone_bt_mac}
_bt_mac_cache: dict[str, str] = {}


def _seed_cache():
    """Populate _dongle_cache from phones.json if not yet loaded.  Must be called under _dongle_lock."""
    global _dongle_cache
    if _dongle_cache is not None:
        return
    _dongle_cache = {}
    try:
        with open(PHONES_JSON_PATH) as f:
            phones = json.load(f)
        for p in phones:
            s = p.get('adb_serial')
            mac = p.get('adapter_mac')
            if s and mac:
                _dongle_cache[s] = mac.upper()
            btm = p.get('phone_bt_mac')
            if s and btm:
                _bt_mac_cache[s] = btm
    except (FileNotFoundError, json.JSONDecodeError, KeyError):
        pass


def save_dongle_assignment(serial: str, adapter_mac: str, phone_bt_mac: str | None = None):
    """Update the in-memory cache and best-effort persist to phones.json."""
    # Update in-memory cache (must be called under _dongle_lock or after allocation)
    if _dongle_cache is not None:
        _dongle_cache[serial] = adapter_mac.upper()
    if phone_bt_mac:
        _bt_mac_cache[serial] = phone_bt_mac

    # Best-effort persist to phones.json (Rust server is also a writer, so
    # this may be overwritten; that's fine because the Rust server gets
    # adapter_mac via POST /phones registration).
    try:
        phones = []
        try:
            with open(PHONES_JSON_PATH) as f:
                phones = json.load(f)
        except (FileNotFoundError, json.JSONDecodeError):
            pass

        found = False
        for p in phones:
            if p.get('adb_serial') == serial:
                p['adapter_mac'] = adapter_mac
                if phone_bt_mac:
                    p['phone_bt_mac'] = phone_bt_mac
                found = True
                break
        if not found:
            entry = {'adb_serial': serial, 'adapter_mac': adapter_mac}
            if phone_bt_mac:
                entry['phone_bt_mac'] = phone_bt_mac
            phones.append(entry)

        os.makedirs(os.path.dirname(PHONES_JSON_PATH), exist_ok=True)
        with open(PHONES_JSON_PATH, 'w') as f:
            json.dump(phones, f, indent=2)
    except OSError as e:
        log.warning(f'Could not persist dongle assignment: {e}')


def allocate_dongle(serial: str) -> tuple[str, str] | None:
    """Allocate a BT dongle for a phone. Returns (adapter_mac, hci_name) or None.

    Strategy:
    1. If phone has a saved assignment AND that dongle is present -> reuse
    2. If saved dongle is gone, try to reassign to a free dongle
    3. If no saved assignment, pick first free dongle

    Retries up to 10 times with 3s backoff waiting for BlueZ to initialize.
    Thread-safe: uses _dongle_lock to prevent TOCTOU races.
    """
    dongles = {}
    for attempt in range(10):
        dongles = enum_dongles()  # {mac: hci_name}
        if dongles:
            break
        if attempt < 9:
            log.info(f'No BT dongles found yet, retrying in 3s ({attempt + 1}/10)...')
            time.sleep(3)
    if not dongles:
        log.warning('No BT dongles found after 10 attempts')
        return None

    with _dongle_lock:
        _seed_cache()
        used_macs = {mac for s, mac in _dongle_cache.items() if s != serial}

        # Check saved assignment
        saved_mac = _dongle_cache.get(serial)
        if saved_mac and saved_mac.upper() in dongles:
            hci = dongles[saved_mac.upper()]
            log.info(f'Reusing saved dongle {saved_mac} ({hci}) for {serial}')
            return (saved_mac.upper(), hci)

        if saved_mac:
            log.warning(f'Saved dongle {saved_mac} not present, reassigning...')

        # Find a free dongle
        for mac, hci in dongles.items():
            if mac not in used_macs:
                log.info(f'Assigning free dongle {mac} ({hci}) to {serial}')
                _dongle_cache[serial] = mac
                save_dongle_assignment(serial, mac)
                return (mac, hci)

        log.error(f'No free BT dongle for {serial}')
        return None


class PortAllocator:
    """Allocates unique ports per phone serial, persisted in phones.json.

    Same serial → same ports across restarts, so ADB forwards, snapshot URLs,
    and VNC ports stay deterministic. New serials get the next free index.
    """

    def __init__(self, snapshot_start: int = 9091, internal_start: int = 8081,
                 display_start: int = 50, vnc_start: int = 5900):
        self._snapshot_start = snapshot_start
        self._internal_start = internal_start
        self._display_start = display_start
        self._vnc_start = vnc_start
        self._lock = threading.Lock()

    def _idx_from_ports(self, snapshot_port: int) -> int:
        return snapshot_port - self._snapshot_start

    def _load_assignments(self) -> dict[str, int]:
        """Read phones.json → {serial: idx}. Returns empty dict on error."""
        try:
            with open(PHONES_JSON_PATH) as f:
                phones = json.load(f)
            out = {}
            for p in phones:
                serial = p.get('adb_serial')
                sp = p.get('snapshot_port')
                if serial and sp:
                    out[serial] = self._idx_from_ports(sp)
            return out
        except (FileNotFoundError, json.JSONDecodeError):
            return {}

    def _save_assignment(self, serial: str, idx: int):
        """Persist port assignment to phones.json."""
        snapshot_port = self._snapshot_start + idx
        internal_port = self._internal_start + idx
        display_num = self._display_start + idx
        vnc_port = self._vnc_start + idx
        try:
            phones = []
            try:
                with open(PHONES_JSON_PATH) as f:
                    phones = json.load(f)
            except (FileNotFoundError, json.JSONDecodeError):
                pass
            found = False
            for p in phones:
                if p.get('adb_serial') == serial:
                    p['snapshot_port'] = snapshot_port
                    p['internal_port'] = internal_port
                    p['display_num'] = display_num
                    p['vnc_port'] = vnc_port
                    found = True
                    break
            if not found:
                phones.append({
                    'adb_serial': serial,
                    'snapshot_port': snapshot_port,
                    'internal_port': internal_port,
                    'display_num': display_num,
                    'vnc_port': vnc_port,
                })
            os.makedirs(os.path.dirname(PHONES_JSON_PATH), exist_ok=True)
            with open(PHONES_JSON_PATH, 'w') as f:
                json.dump(phones, f, indent=2)
        except OSError as e:
            log.warning(f'Failed to persist port assignment for {serial}: {e}')

    def allocate(self, serial: str) -> tuple[int, int, int, int]:
        """Allocate ports for a serial. Reuses saved assignment if present.

        Thread-safe via _lock — prevents two threads picking the same idx.
        Always re-saves to phones.json so any stale/inconsistent saved values
        get rewritten with the correct derived ports for this idx.
        """
        with self._lock:
            assignments = self._load_assignments()  # {serial: idx}
            # Reuse if we already have an assignment
            if serial in assignments:
                idx = assignments[serial]
                log.info(f'Reusing saved ports for {serial}: idx={idx}')
            else:
                used = set(assignments.values())
                idx = 0
                while idx in used:
                    idx += 1
                log.info(f'Assigning new ports for {serial}: idx={idx}')
            # Always re-save: rewrites stale/wrong port values from older allocator runs
            self._save_assignment(serial, idx)
            return (
                self._snapshot_start + idx,
                self._internal_start + idx,
                self._display_start + idx,
                self._vnc_start + idx,
            )

    def release(self, snapshot_port: int):
        # Ports are persisted per-serial — they stay reserved across disconnects
        # so that the same phone gets the same ports on replug. No-op here.
        pass


class PhoneMonitor:
    """Lifecycle manager for a single phone."""

    def __init__(self, serial: str, snapshot_port: int, internal_port: int,
                 display_num: int, vnc_port: int):
        self.serial = serial
        self.snapshot_port = snapshot_port
        self.internal_port = internal_port
        self.display_num = display_num
        self.vnc_port = vnc_port
        self.snapshot_url = f'http://127.0.0.1:{self.snapshot_port}'
        self.phone_id: str | None = None
        self.adapter_mac: str | None = None  # assigned BT dongle MAC
        self.adapter_hci: str | None = None  # assigned BT dongle hci name (e.g. "hci1")
        self.phone_bt_mac: str | None = None  # phone's BT MAC
        self.stopped = threading.Event()
        self._display_procs: list[subprocess.Popen] = []
        self._display_log_files: list = []
        self.log = logging.getLogger(f'phone[{serial}]')

    def adb(self, *args: str, timeout: int = 10) -> str:
        return adb(self.serial, *args, timeout=timeout)

    def adb_shell(self, cmd: str, timeout: int = 10) -> str:
        return adb_shell(self.serial, cmd, timeout=timeout)

    def is_connected(self) -> bool:
        for _ in range(3):
            state = adb(self.serial, 'get-state')
            if state == 'device':
                return True
            time.sleep(2)
        return False

    # --- Display (Xvnc + scrcpy) ---

    def _get_display_resolution(self) -> tuple[int, int]:
        """Detect phone resolution and scale down for scrcpy display."""
        raw = self.adb_shell('wm size')
        match = re.search(r'(\d+)x(\d+)', raw)
        if not match:
            self.log.warning('Could not detect resolution, using 360x800')
            return 360, 800
        phone_w, phone_h = int(match.group(1)), int(match.group(2))
        max_size = int(os.environ.get('SCRCPY_MAX_SIZE', '800'))
        scale = max_size / max(phone_w, phone_h)
        w = int(phone_w * scale) // 2 * 2  # make even
        h = int(phone_h * scale) // 2 * 2
        return w, h

    def start_display(self):
        """Spawn Xvnc and scrcpy for this phone."""
        display_w, display_h = self._get_display_resolution()
        resolution = f'{display_w}x{display_h}'
        display = f':{self.display_num}'

        vnc_auth = os.environ.get('VNC_AUTH_ARGS', '-SecurityTypes None')
        xvnc_cmd = [
            'Xvnc', display,
            '-geometry', resolution, '-depth', '24',
            '-rfbport', str(self.vnc_port),
            *vnc_auth.split(),
            '-localhost', 'no', '-AlwaysShared',
        ]
        # Clean up stale X lock files/sockets from previous runs
        lock_file = f'/tmp/.X{self.display_num}-lock'
        socket_file = f'/tmp/.X11-unix/X{self.display_num}'
        for f in (lock_file, socket_file):
            try:
                os.remove(f)
            except FileNotFoundError:
                pass

        self.log.info(f'Starting Xvnc on display {display} port {self.vnc_port} ({resolution})')
        try:
            proc = subprocess.Popen(xvnc_cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            self._display_procs.append(proc)
        except FileNotFoundError:
            self.log.error('Xvnc not found — skipping display')
            return

        # Wait for Xvnc to be ready (check VNC port)
        for _ in range(10):
            time.sleep(0.5)
            try:
                s = socket.create_connection(('127.0.0.1', self.vnc_port), timeout=1)
                s.close()
                break
            except OSError:
                pass
        else:
            self.log.warning(f'Xvnc on port {self.vnc_port} did not become ready')

        # Set cursor
        try:
            subprocess.Popen(
                ['xsetroot', '-cursor_name', 'left_ptr'],
                env={**os.environ, 'DISPLAY': display},
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            )
        except FileNotFoundError:
            pass

        max_fps = os.environ.get('SCRCPY_MAX_FPS', '15')
        bitrate = os.environ.get('SCRCPY_BITRATE', '2M')
        scrcpy_cmd = [
            'scrcpy',
            '--serial', self.serial,
            '--no-audio',
            '--max-fps', max_fps,
            '-b', bitrate,
            '--render-driver=opengl',
            '--window-width', str(display_w),
            '--window-height', str(display_h),
            '--window-borderless',
            '--window-x', '0', '--window-y', '0',
        ]
        scrcpy_log = f'/tmp/scrcpy-{self.serial}.log'
        self.log.info(f'Starting scrcpy for {self.serial} on {display} (log: {scrcpy_log})')
        try:
            log_file = open(scrcpy_log, 'w')
            proc = subprocess.Popen(
                scrcpy_cmd,
                env={**os.environ, 'DISPLAY': display},
                stdout=log_file, stderr=log_file,
            )
            self._display_procs.append(proc)
            self._display_log_files.append(log_file)
        except FileNotFoundError:
            self.log.error('scrcpy not found — skipping')

    def stop_display(self):
        """Kill Xvnc and scrcpy processes for this phone."""
        for proc in self._display_procs:
            try:
                proc.terminate()
            except OSError:
                pass
        for proc in self._display_procs:
            try:
                proc.wait(timeout=5)
            except (subprocess.TimeoutExpired, OSError):
                try:
                    proc.kill()
                    proc.wait(timeout=2)
                except OSError:
                    pass
        self._display_procs.clear()
        for f in self._display_log_files:
            try:
                f.close()
            except OSError:
                pass
        self._display_log_files.clear()

    # --- Setup steps ---

    def configure_screen(self):
        self.log.info('Configuring screen...')
        self.adb_shell('settings put global stay_on_while_plugged_in 0')
        self.adb_shell('settings put system screen_off_timeout 300000')  # 5 min
        self.adb_shell('settings put system screen_brightness_mode 1')
        self.adb_shell('locksettings set-password-quality 0')
        self.adb_shell('svc data disable')
        self.adb_shell('pm disable-user --user 0 com.google.android.apps.messaging')

    def configure_silent(self):
        """Mute all alerts + vibrations. Kiosk phones should be silent.

        Sets stream volumes to 0 directly (not via DISALLOW_ADJUST_VOLUME which
        breaks BlueALSA BT audio on Samsung). Disables vibration on ring/touch.
        Per-stream mute leaves voice_call/music alone so HFP/A2DP audio still works.
        """
        self.log.info('Setting silent mode...')
        # Mute the user-facing alert streams (keep music/voice for our audio routing)
        for stream in ('5', '2', '1', '8'):  # NOTIFICATION, RING, SYSTEM, ACCESSIBILITY
            self.adb_shell(f'media volume --stream {stream} --set 0 2>/dev/null || true')
        self.adb_shell('cmd notification set_dnd alarms')  # zen=3: silence ring/notif, keep media+alarms
        # Disable vibration
        self.adb_shell('settings put system vibrate_when_ringing 0')
        self.adb_shell('settings put system haptic_feedback_enabled 0')
        self.adb_shell('settings put system notification_vibration_intensity 0 2>/dev/null || true')
        self.adb_shell('settings put system ring_vibration_intensity 0 2>/dev/null || true')
        self.adb_shell('settings put system touch_vibration_intensity 0 2>/dev/null || true')

    def is_device_owner_set(self) -> bool:
        output = self.adb_shell('dpm list-owners')
        return DEVICE_OWNER_PKG in output

    def grant_permissions(self):
        for perm in RUNTIME_PERMISSIONS:
            self.adb_shell(f'pm grant {DEVICE_OWNER_PKG} {perm}')

    def provision_device_owner(self):
        if self.is_device_owner_set():
            self.log.info('Device owner already set')
            if os.path.exists(APK_PATH):
                result = self.adb('install', '-r', APK_PATH, timeout=30)
                if 'Success' in result:
                    self.log.info('APK updated')
            self.grant_permissions()
            self.adb_shell(
                f'am broadcast -a {DEVICE_OWNER_PKG}.CLEAR_RESTRICTIONS '
                f'-n {DEVICE_OWNER_PKG}/.BootReceiver'
            )
            return

        self.log.info('Device owner not set — provisioning...')
        account_dump = self.adb_shell('dumpsys account')
        account_count = account_dump.count('Account {')
        if account_count > 0:
            self.log.error(f'Phone has {account_count} account(s). Factory reset required.')
            return

        if not os.path.exists(APK_PATH):
            self.log.warning(f'{APK_PATH} not found — skipping')
            return

        self.adb('install', '-r', APK_PATH, timeout=30)
        self.adb_shell(f'dpm set-device-owner {DEVICE_OWNER_RECEIVER}')
        self.adb_shell(f'cmd notification allow_listener {DEVICE_OWNER_PKG}/.OtaconNotificationListener')
        self.grant_permissions()
        self.log.info('Device owner provisioned')

    def start_snapshot_server(self):
        if not os.path.exists(JAR_PATH):
            self.log.warning(f'{JAR_PATH} not found — skipping')
            return

        self.adb('push', JAR_PATH, '/data/local/tmp/snapshot-server.jar', timeout=15)
        self.adb_shell('pkill -f snapshot-server.jar')
        time.sleep(1)
        self.adb_shell(
            'nohup app_process -Djava.class.path=/data/local/tmp/snapshot-server.jar '
            '/ com.otacon.snapshot.SnapshotServer > /dev/null 2>&1 &'
        )
        self.log.info('Snapshot server started')

    def setup_port_forwards(self):
        self.adb('forward', f'tcp:{self.snapshot_port}', 'tcp:9091')
        self.adb('reverse', f'tcp:{self.internal_port}', f'tcp:{self.internal_port}')
        self.log.info(f'Port forwards: snapshot={self.snapshot_port}, internal={self.internal_port}')

    def wait_for_server(self, url: str, name: str, retries: int = 10) -> bool:
        for _ in range(retries):
            result = http_get(f'{url}/health', timeout=2)
            if isinstance(result, dict) and result.get('ok'):
                self.log.info(f'{name} connected')
                return True
            time.sleep(1)
        self.log.warning(f'{name} not available')
        return False

    def clear_passcode_if_set(self):
        """Detect if the phone has a screen-lock passcode and clear it.

        Otacon needs unattended access — passcodes prevent that. We try in order:
        1. `locksettings clear --old <pin>` if a known PIN is configured for this phone
        2. Device-owner resetPasswordWithToken (requires prior token activation)
        3. /lock/activate with known PIN to activate token, then clear
        """
        status = self.adb_shell(
            "content query --uri 'content://com.otacon.kiosk/lock/status'"
        )
        if not status:
            return
        if 'is_secure=true' not in status:
            return  # no passcode set
        self.log.warning('Passcode detected — attempting clear...')

        # Try known PINs from env (PHONE_PIN_<SERIAL>) — comma-separated list of PINs to try
        env_key = f'PHONE_PIN_{self.serial}'
        pins = os.environ.get(env_key, '').split(',')
        for pin in pins:
            pin = pin.strip()
            if not pin:
                continue
            result = self.adb_shell(f'locksettings clear --old {pin}')
            if result and 'cleared' in result.lower():
                self.log.info(f'Passcode cleared via locksettings (pin matched)')
                return

        # Try device-owner token-based reset
        result = self.adb_shell(
            "content query --uri 'content://com.otacon.kiosk/lock/clear'"
        )
        if result and 'ok=true' in result:
            self.log.info('Passcode cleared via device-owner token')
            return

        # Token not activated — try activating with known PINs
        for pin in pins:
            pin = pin.strip()
            if not pin:
                continue
            activate = self.adb_shell(
                f"content query --uri 'content://com.otacon.kiosk/lock/activate?password={pin}'"
            )
            if activate and 'token_activated=true' in activate:
                self.log.info(f'Token activated with known PIN')
                # Now try clearing again
                result = self.adb_shell(
                    "content query --uri 'content://com.otacon.kiosk/lock/clear'"
                )
                if result and 'ok=true' in result:
                    self.log.info('Passcode cleared via token after activation')
                    return

        self.log.error(f'Failed to clear passcode: {result}')
        self.report_error('password.locked_no_token',
                          f'Cannot clear passcode — token not activated')

    def connect_wifi(self):
        ssid = os.environ.get('WIFI_AP_SSID', '')
        password = os.environ.get('WIFI_AP_PASSWORD', '')
        if not ssid:
            return

        self.log.info(f"Connecting WiFi '{ssid}' (hidden AP)...")
        # `cmd wifi` runs as system shell — bypasses DISALLOW_CONFIG_WIFI restriction
        # which Samsung Knox refuses to let our Device Owner clear.
        # The -h flag marks the network as hidden so the phone actively probes for the SSID.
        result = self.adb_shell(
            f'cmd wifi connect-network "{ssid}" wpa2 "{password}" -h'
        )
        if result and 'successful' in result.lower():
            self.log.info('WiFi connect requested via cmd wifi -h')
        # Fallback to ContentProvider (pre-existing path) if cmd wifi unavailable
        elif not result:
            self.adb_shell(
                f"content query --uri 'content://com.otacon.kiosk/wifi/connect?ssid={ssid}&password={password}'"
            )

    def apply_restrictions(self):
        if not self.is_device_owner_set():
            return
        self.adb_shell(
            f'am broadcast -a {DEVICE_OWNER_PKG}.CLEAR_RESTRICTIONS '
            f'-n {DEVICE_OWNER_PKG}/.BootReceiver'
        )
        time.sleep(1)
        self.adb_shell(
            f'am broadcast -a {DEVICE_OWNER_PKG}.APPLY_RESTRICTIONS '
            f'-n {DEVICE_OWNER_PKG}/.BootReceiver'
        )
        self.adb_shell(f'cmd notification allow_listener {DEVICE_OWNER_PKG}/.OtaconNotificationListener')
        self.log.info('Restrictions applied')

    def ensure_screen_on(self):
        """Wake the phone if its screen is off. Pair dialogs require screen on."""
        try:
            state = self.adb_shell('dumpsys display | grep mScreenState | head -1')
            if 'ON' in (state or ''):
                return  # already on
            self.log.info('Screen is off — sending WAKEUP keyevent')
            self.adb_shell('input keyevent 224')  # KEYCODE_WAKEUP
            time.sleep(0.5)
        except Exception as e:
            self.log.warning(f'ensure_screen_on failed: {e}')

    def allocate_and_pair_bluetooth(self):
        """Allocate a BT dongle and pair the phone with it."""
        if os.environ.get('AUDIO_BACKEND') != 'bluetooth':
            return

        # Allocate dongle
        result = allocate_dongle(self.serial)
        if not result:
            self.report_error('bluetooth.no_free_dongle',
                              f'No free BT dongle available for {self.serial}')
            return
        self.adapter_mac, self.adapter_hci = result

        # Get phone's BT MAC (from ADB, or fall back to saved value in phones.json)
        self.phone_bt_mac = self.adb_shell('settings get secure bluetooth_address').strip()
        if not self.phone_bt_mac or self.phone_bt_mac == 'null':
            self.phone_bt_mac = None
        if not self.phone_bt_mac:
            # Check in-memory cache first (populated during dongle allocation)
            cached = _bt_mac_cache.get(self.serial)
            if cached:
                self.phone_bt_mac = cached
                self.log.info(f'Restored phone_bt_mac from cache: {self.phone_bt_mac}')
            else:
                try:
                    with open(PHONES_JSON_PATH) as f:
                        for p in json.load(f):
                            if p.get('adb_serial') == self.serial and p.get('phone_bt_mac'):
                                self.phone_bt_mac = p['phone_bt_mac']
                                self.log.info(f'Restored phone_bt_mac from phones.json: {self.phone_bt_mac}')
                                break
                except (FileNotFoundError, json.JSONDecodeError, KeyError):
                    pass

        self.log.info(f'Pairing with dongle {self.adapter_mac} ({self.adapter_hci}), phone BT: {self.phone_bt_mac}')

        # Clear stale phone-side bonds with OTHER dongles so discovery works.
        # A phone that thinks it's paired with a dongle won't broadcast in
        # discovery mode, causing the Pi-side pair to never find it.
        all_dongles = enum_dongles()
        for mac, _hci in all_dongles.items():
            if mac.upper() != self.adapter_mac.upper():
                self.log.info(f'Clearing stale phone-side bond with {mac} (not our adapter)')
                self.adb_shell(
                    f"content query --uri 'content://com.otacon.kiosk/bluetooth/unpair?mac={mac}'",
                    timeout=10
                )

        pair_result = {}
        pair_done = threading.Event()

        def do_pair():
            # Tell the phone to pair with our assigned dongle's MAC
            result = self.adb_shell(
                f"content query --uri 'content://com.otacon.kiosk/bluetooth/pair?mac={self.adapter_mac}'",
                timeout=45
            )
            pair_result['data'] = result
            pair_done.set()

        # Make sure screen is on before pairing starts — pair dialogs only appear
        # while the screen is awake.
        self.ensure_screen_on()

        # Run bluetooth-pair.sh with the assigned adapter and serial
        pair_script = threading.Thread(target=self._run_pair_script, daemon=True)
        pair_script.start()

        pair_thread = threading.Thread(target=do_pair, daemon=True)
        pair_thread.start()

        tapped = False
        for i in range(30):
            time.sleep(1)
            # Re-wake screen if it has gone off during the wait — Android pair
            # dialogs are dismissed when the screen sleeps, blocking the tap.
            if i % 5 == 0:  # check every 5s to avoid spamming
                self.ensure_screen_on()
            # Strategy A (Samsung): foreground AlertDialog with "Pair" button
            ref = self.find_pair_button()
            if ref:
                self.log.info(f"Auto-tapping 'Pair' button ({ref})")
                http_post(f'{self.snapshot_url}/action', {'action': 'click', 'ref': ref})
                tapped = True
                break
            # Strategy B (Pixel): notification with "Pair & connect" action
            if self.tap_pair_notification():
                tapped = True
                break

        # KioskProvider loops up to 60x500ms (30s) waiting for bond; give it time
        pair_thread.join(timeout=45)
        result = pair_result.get('data', '')

        # Detect stale one-sided bond: phone says already_paired but BlueZ
        # on our adapter has no record.  Force unpair on phone and retry.
        if 'already_paired' in result and self.phone_bt_mac:
            bluez_check = subprocess.run(
                ['bluetoothctl'],
                input=f'select {self.adapter_mac}\ninfo {self.phone_bt_mac}\n',
                capture_output=True, text=True, timeout=10,
            )
            if 'Paired: yes' not in (bluez_check.stdout or ''):
                self.log.warning('Phone reports already_paired but BlueZ has no record — forcing unpair and retrying')
                self.adb_shell(
                    f"content query --uri 'content://com.otacon.kiosk/bluetooth/unpair?mac={self.adapter_mac}'",
                    timeout=10
                )
                time.sleep(2)
                # Retry pairing
                pair_result.clear()
                pair_done.clear()
                retry_script = threading.Thread(target=self._run_pair_script, daemon=True)
                retry_script.start()
                retry_thread = threading.Thread(target=do_pair, daemon=True)
                retry_thread.start()
                self.ensure_screen_on()
                for i in range(30):
                    time.sleep(1)
                    if i % 5 == 0:
                        self.ensure_screen_on()
                    ref = self.find_pair_button()
                    if ref:
                        self.log.info(f"Auto-tapping 'Pair' button ({ref}) [retry]")
                        http_post(f'{self.snapshot_url}/action', {'action': 'click', 'ref': ref})
                        break
                    if self.tap_pair_notification():
                        break
                retry_thread.join(timeout=45)
                result = pair_result.get('data', '')

        if 'ok=true' in result:
            status = 'paired' if 'paired' in result else 'ok'
        elif 'error=' in result:
            status = result.split('error=')[-1].strip()
        else:
            status = result or 'unknown'
        self.log.info(f'Bluetooth pairing: {status}')

        # After successful pairing, trust the phone and persist phone_bt_mac
        if self.phone_bt_mac and 'ok=true' in (pair_result.get('data', '')):
            # Persist phone_bt_mac alongside adapter_mac
            save_dongle_assignment(self.serial, self.adapter_mac, self.phone_bt_mac)
            try:
                # Pipe select + trust into one bluetoothctl session so the
                # adapter selection actually applies to the trust command.
                subprocess.run(
                    ['bluetoothctl'],
                    input=f'select {self.adapter_mac}\ntrust {self.phone_bt_mac}\n',
                    capture_output=True, text=True, timeout=10,
                )
                self.log.info(f'Trusted {self.phone_bt_mac} on {self.adapter_mac}')
            except (subprocess.TimeoutExpired, FileNotFoundError):
                pass

    def _run_pair_script(self):
        """Run bluetooth-pair.sh with the assigned adapter."""
        try:
            result = subprocess.run(
                ['/opt/bluetooth-pair.sh',
                 '--adapter', self.adapter_hci,
                 '--serial', self.serial],
                capture_output=True, text=True, timeout=60,
            )
            if result.returncode != 0:
                self.log.warning(f'bluetooth-pair.sh exit={result.returncode}\n'
                                 f'  stdout: {result.stdout.strip()}\n'
                                 f'  stderr: {result.stderr.strip()}')
            else:
                self.log.info(f'bluetooth-pair.sh completed: {result.stdout.strip()[-200:]}')
        except (subprocess.TimeoutExpired, FileNotFoundError) as e:
            self.log.warning(f'bluetooth-pair.sh failed: {e}')

    def report_error(self, category: str, message: str, data: dict | None = None):
        """Report an error to the registry (fire and forget)."""
        registry_url = os.environ.get('REGISTRY_URL')
        if not registry_url:
            self.log.error(f'[{category}] {message}')
            return
        host_id = os.environ.get('HOST_ID', '')
        payload = {
            'host_id': host_id,
            'phone_id': self.phone_id,
            'severity': 'error',
            'category': category,
            'message': message,
        }
        if data:
            payload['data'] = data
        http_post(f'{registry_url}/api/v1/events', payload)
        self.log.error(f'[{category}] {message}')

    def tap_pair_notification(self) -> bool:
        """Find a 'Pairing request' notification and trigger its Pair action.

        Pixel/AOSP shows BT pair as a heads-up notification (not a foreground
        dialog), so the screen accessibility tree won't see it. We poll the
        notification listener and trigger action by index.
        """
        try:
            text = self.adb_shell(
                "content query --uri 'content://com.otacon.kiosk/notifications'",
                timeout=3,
            )
        except Exception:
            return False
        if not text:
            return False
        # Output format: "Row: 0 json=[...]"
        match = re.search(r'json=(\[.*\])', text)
        if not match:
            return False
        try:
            notifs = json.loads(match.group(1))
        except json.JSONDecodeError:
            return False
        for n in notifs:
            if n.get('package') != 'com.android.settings':
                continue
            title = (n.get('title') or '').lower()
            if 'pair' not in title:
                continue
            for action in n.get('actions') or []:
                atitle = (action.get('title') or '').lower()
                if 'pair' in atitle and 'cancel' not in atitle and 'block' not in atitle:
                    key = n.get('key')
                    idx = action.get('index')
                    if key is None or idx is None:
                        continue
                    enc_key = urllib.parse.quote(str(key), safe='')
                    self.log.info(f"Triggering pair notification action key={key} idx={idx}")
                    self.adb_shell(
                        f"content query --uri 'content://com.otacon.kiosk/notifications/action?key={enc_key}&index={idx}'",
                        timeout=5,
                    )
                    return True
        return False

    def find_pair_button(self) -> str | None:
        data = http_get(f'{self.snapshot_url}/snapshot?format=json', timeout=3)
        if not data:
            return None

        # Match common pairing button texts across manufacturers:
        # Samsung: "Pair", Pixel: "PAIR" or "Allow", AOSP: "pair"
        PAIR_TEXTS = {'pair', 'allow'}

        def walk(node):
            text = (node.get('text') or '').strip().lower()
            if text in PAIR_TEXTS and node.get('clickable'):
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

    # --- Registry integration ---

    def gather_identity(self) -> dict:
        """Collect phone identity for registry registration."""
        model = self.adb_shell('getprop ro.product.model')
        bt_mac = self.adb_shell('settings get secure bluetooth_address')
        imei = self.adb_shell(
            "service call iphonesubinfo 1 | grep -o '[0-9a-f]\\{8\\}' | tail -n+2 | "
            "while read a; do echo -n \"\\u${a:4:4}\\u${a:0:4}\"; done"
        )
        phone_number = self.adb_shell(
            "content query --uri content://com.otacon.kiosk/device/phone-number "
            "2>/dev/null | grep -o 'number=.*' | cut -d= -f2"
        )
        return {
            'adb_serial': self.serial,
            'phone_number': phone_number or None,
            'model': model or None,
            'bt_mac': bt_mac if bt_mac and bt_mac != 'null' else None,
            'imei': imei if imei and len(imei) >= 14 else None,
        }

    def register_with_registry(self, identity: dict) -> dict | None:
        """Report this phone to the central registry, get back config."""
        registry_url = os.environ.get('REGISTRY_URL')
        if not registry_url:
            return None
        host_id = os.environ.get('HOST_ID', '')
        payload = {
            'host_id': host_id,
            **identity,
        }
        if self.adapter_mac:
            payload['adapter_mac'] = self.adapter_mac
        result = http_post(f'{registry_url}/api/v1/phones/register', payload)
        if result:
            self.phone_id = result.get('phone_id')
            self.log.info(f'Registered with registry as {self.phone_id}')
            return result.get('config')
        return None

    def deregister_from_registry(self):
        registry_url = os.environ.get('REGISTRY_URL')
        if not registry_url or not self.phone_id:
            return
        host_id = os.environ.get('HOST_ID', '')
        http_post(f'{registry_url}/api/v1/phones/deregister', {
            'host_id': host_id,
            'phone_id': self.phone_id,
        })
        self.log.info(f'Deregistered {self.phone_id} from registry')

    def register_with_server(self, identity: dict):
        """Register this phone with the local Rust server."""
        payload = {
            'adb_serial': self.serial,
            'id': self.phone_id,
            'snapshot_port': self.snapshot_port,
            'internal_port': self.internal_port,
        }
        if self.adapter_mac:
            payload['adapter_mac'] = self.adapter_mac
        if self.phone_bt_mac:
            payload['phone_bt_mac'] = self.phone_bt_mac
        result = http_post(f'{RUST_SERVER_URL}/phones', payload)
        if result:
            server_id = result.get('id', self.phone_id)
            if server_id:
                self.phone_id = server_id
            self.log.info(f'Registered with Rust server as {self.phone_id}')

    def deregister_from_server(self):
        """Remove this phone from the local Rust server."""
        if not self.phone_id:
            return
        try:
            req = Request(f'{RUST_SERVER_URL}/phones/{self.phone_id}', method='DELETE')
            urlopen(req, timeout=5)
            self.log.info(f'Deregistered {self.phone_id} from Rust server')
        except (URLError, OSError, TimeoutError):
            pass

    def apply_config(self, config: dict):
        """Apply registry-provided settings to the phone."""
        if not config:
            return
        if config.get('wifi_enabled') is not None:
            self.adb_shell(
                f"svc wifi {'enable' if config['wifi_enabled'] else 'disable'}"
            )
        if config.get('bluetooth_enabled') is not None:
            self.adb_shell(
                f"svc bluetooth {'enable' if config['bluetooth_enabled'] else 'disable'}"
            )

    # --- Main lifecycle ---

    def run(self):
        """Full phone setup and monitoring loop. Blocks until disconnect."""
        self.log.info(f'Starting setup (snapshot_port={self.snapshot_port}, internal_port={self.internal_port}, display=:{self.display_num}, vnc={self.vnc_port})')
        time.sleep(2)  # let device initialize

        self.configure_screen()
        self.configure_silent()
        self.provision_device_owner()
        self.start_snapshot_server()
        self.setup_port_forwards()
        self.wait_for_server(self.snapshot_url, 'Snapshot server')
        self.clear_passcode_if_set()
        self.connect_wifi()
        self.allocate_and_pair_bluetooth()
        self.apply_restrictions()
        # Display (Xvnc + scrcpy) is now lazy — spawned by Rust server on first VNC connection

        # Gather identity and register
        identity = self.gather_identity()
        config = self.register_with_registry(identity)
        if config:
            self.apply_config(config)
        self.register_with_server(identity)

        self.log.info('Setup complete')

        # Monitor connection + keep services alive
        passcode_check_counter = 0
        while not self.stopped.is_set() and self.is_connected():
            self.setup_port_forwards()

            # Retry BT allocation if it failed at startup (BlueZ may not have been ready)
            if not self.adapter_mac:
                self.allocate_and_pair_bluetooth()
                if self.adapter_mac:
                    # Re-register with server so it gets the new adapter/phone BT MACs
                    identity = self.gather_identity()
                    self.register_with_server(identity)

            # Periodic passcode check (every ~5 minutes = 30 iterations of 10s sleep)
            passcode_check_counter += 1
            if passcode_check_counter >= 30:
                passcode_check_counter = 0
                self.clear_passcode_if_set()

            # Restart snapshot server if process died
            proc_check = self.adb_shell('pgrep -f snapshot-server.jar')
            if not proc_check.strip():
                self.log.warning('Snapshot server dead — restarting')
                self.start_snapshot_server()
                time.sleep(3)
                self.setup_port_forwards()

            # Display processes are now managed lazily by the Rust server

            self.stopped.wait(10)

        self.log.info('Disconnected')
        self.deregister_from_server()
        self.deregister_from_registry()

    def stop(self):
        self.stopped.set()


class DeviceManager:
    """Watches for ADB devices and spawns PhoneMonitors."""

    DISCONNECT_GRACE = 3  # consecutive misses before removing

    def __init__(self):
        self.monitors: dict[str, tuple[PhoneMonitor, threading.Thread]] = {}
        self.port_allocator = PortAllocator(snapshot_start=9091, internal_start=8081)
        self._missing_count: dict[str, int] = {}
        self._lock = threading.Lock()

    def report_dongles(self):
        """Report all BT dongles to the registry."""
        registry_url = os.environ.get('REGISTRY_URL')
        if not registry_url:
            return
        dongles = enum_dongles()
        if not dongles:
            return
        host_id = os.environ.get('HOST_ID', '')
        assignments = load_dongle_assignments()
        # Build dongle list with current phone assignments
        dongle_list = []
        for mac, hci in dongles.items():
            phone_id = None
            for serial, assigned_mac in assignments.items():
                if assigned_mac and assigned_mac.upper() == mac:
                    # Look up phone_id from active monitors
                    with self._lock:
                        if serial in self.monitors:
                            phone_id = self.monitors[serial][0].phone_id
                    break
            dongle_list.append({
                'bt_mac': mac,
                'hci_device': hci,
                'phone_id': phone_id,
            })
        http_post(f'{registry_url}/api/v1/dongles/register', {
            'host_id': host_id,
            'dongles': dongle_list,
        })
        log.info(f'Reported {len(dongle_list)} dongles to registry')

    def run(self):
        log.info('Device manager started')
        self.report_dongles()
        while True:
            current_serials = get_connected_serials()

            with self._lock:
                # Start monitors for new devices
                for serial in current_serials - set(self.monitors.keys()):
                    snapshot_port, internal_port, display_num, vnc_port = self.port_allocator.allocate(serial)
                    monitor = PhoneMonitor(serial, snapshot_port, internal_port, display_num, vnc_port)
                    thread = threading.Thread(target=monitor.run, daemon=True, name=f'phone-{serial}')
                    thread.start()
                    self.monitors[serial] = (monitor, thread)
                    self._missing_count.pop(serial, None)
                    log.info(f'Started monitor for {serial}')

                # Clean up disconnected devices (with grace period)
                for serial in list(self.monitors.keys()):
                    if serial not in current_serials:
                        self._missing_count[serial] = self._missing_count.get(serial, 0) + 1
                        if self._missing_count[serial] >= self.DISCONNECT_GRACE:
                            monitor, thread = self.monitors.pop(serial)
                            monitor.stop()
                            self.port_allocator.release(monitor.snapshot_port)
                            self._missing_count.pop(serial, None)
                            log.info(f'Removed monitor for {serial} (missing {self.DISCONNECT_GRACE} checks)')
                    else:
                        self._missing_count.pop(serial, None)

            time.sleep(2)


def main():
    manager = DeviceManager()
    manager.run()


if __name__ == '__main__':
    main()
