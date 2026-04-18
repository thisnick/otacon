"""PhoneAgent — per-phone state machine. Replaces PhoneMonitor from device-monitor.py."""

import logging
import os
import threading
import time

from ..util.adb import adb, adb_shell
from ..util.http import http_get, http_post
from .status import MonitorStatus, StepStatus, HealStatus, now_iso, push_status
from . import health, heal
from ..steps import screen, provisioning, snapshot, passcode, wifi
from ..bluetooth.pair import allocate_and_pair_bluetooth, run_pair_dialog_watcher
from ..registry.identity import gather_identity
from ..registry.client import register_with_registry, deregister_from_registry, report_error
from ..registry.server import register_with_server, deregister_from_server

log = logging.getLogger('fleet-agent')

# Map check names to (check_fn, heal_fn) — populated in PhoneAgent
SETUP_STEPS = [
    'configure_screen',
    'configure_silent',
    'provision_device_owner',
    'start_snapshot_server',
    'setup_port_forwards',
    'wait_for_server',
    'clear_passcode_if_set',
    'connect_wifi',
    'allocate_and_pair_bluetooth',
    'apply_restrictions',
    'register',
]


class PhoneAgent:
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
        self.registry_id: str | None = None
        self.adapter_mac: str | None = None
        self.adapter_hci: str | None = None
        self.phone_bt_mac: str | None = None
        self.stopped = threading.Event()
        self._pair_watcher_thread: threading.Thread | None = None
        self.status = MonitorStatus()
        self.log = logging.getLogger(f'phone[{serial}]')

    def is_connected(self) -> bool:
        for _ in range(3):
            state = adb(self.serial, 'get-state')
            if state == 'device':
                return True
            time.sleep(2)
        return False

    def _report_error(self, category: str, message: str, data: dict | None = None):
        report_error(category, message,
                      phone_id=self.registry_id or self.phone_id, data=data)

    def _run_step(self, name: str, fn, *args, **kwargs):
        """Run a setup step, tracking status."""
        step = self.status.setup.setdefault(name, StepStatus())
        step.attempted = True
        step.attempted_at = now_iso()
        try:
            result = fn(*args, **kwargs)
            step.succeeded = True
            step.succeeded_at = now_iso()
            step.error = None
            return result
        except Exception as e:
            step.error = str(e)
            self.log.error(f'Step {name} failed: {e}')
            return None

    def run_setup(self):
        """Run all one-shot setup steps."""
        self.log.info(f'Starting setup (snapshot_port={self.snapshot_port}, internal_port={self.internal_port})')
        time.sleep(2)  # let device initialize

        self._run_step('configure_screen', screen.configure_screen, self.serial)
        self._run_step('configure_silent', screen.configure_silent, self.serial)
        self._run_step('provision_device_owner', provisioning.provision_device_owner, self.serial)
        self._run_step('start_snapshot_server', snapshot.start_snapshot_server, self.serial)
        self._run_step('setup_port_forwards', snapshot.setup_port_forwards,
                        self.serial, self.snapshot_port, self.internal_port)

        self._run_step('wait_for_server', self._wait_for_server)
        self._run_step('clear_passcode_if_set', passcode.clear_passcode_if_set,
                        self.serial, self._report_error)
        self._run_step('connect_wifi', wifi.connect_wifi, self.serial)

        result = self._run_step('allocate_and_pair_bluetooth',
                                 allocate_and_pair_bluetooth,
                                 self.serial, self.snapshot_url, self._report_error)
        if result:
            self.adapter_mac, self.adapter_hci, self.phone_bt_mac = result

        self._run_step('apply_restrictions', provisioning.apply_restrictions, self.serial)

        # Gather identity and register
        identity = gather_identity(self.serial)
        self._run_step('register', self._register, identity)

        self.log.info('Setup complete')

    def _wait_for_server(self):
        for _ in range(10):
            result = http_get(f'{self.snapshot_url}/health', timeout=2)
            if isinstance(result, dict) and result.get('ok'):
                self.log.info('Snapshot server connected')
                return
            time.sleep(1)
        self.log.warning('Snapshot server not available')

    def _register(self, identity: dict):
        rid, config = register_with_registry(
            identity, adapter_mac=self.adapter_mac)
        if rid:
            self.registry_id = rid
        if config:
            self._apply_config(config)
        phone_id = register_with_server(
            self.serial, self.snapshot_port, self.internal_port,
            adapter_mac=self.adapter_mac, phone_bt_mac=self.phone_bt_mac)
        if phone_id:
            self.phone_id = phone_id

    def _apply_config(self, config: dict):
        if not config:
            return
        if config.get('wifi_enabled') is not None:
            adb_shell(self.serial,
                f"svc wifi {'enable' if config['wifi_enabled'] else 'disable'}")
        if config.get('bluetooth_enabled') is not None:
            adb_shell(self.serial,
                f"svc bluetooth {'enable' if config['bluetooth_enabled'] else 'disable'}")

    def run_maintenance_tick(self):
        """Run all health checks and heal failures."""
        checks = self._get_checks()
        for name, check_fn in checks.items():
            try:
                result = check_fn()
            except Exception as e:
                self.log.warning(f'Check {name} error: {e}')
                result = False
            self.status.health[name] = result
            if not result:
                # Skip bt_connected heal when bt_bonded is failing — reconnect
                # is impossible without a bond, so only the bond heal matters.
                if name == 'bt_connected' and not self.status.health.get('bt_bonded', True):
                    continue
                self._run_heal(name)
        self.status.loop_iteration += 1
        self.status.last_check_at = now_iso()

    def _get_checks(self) -> dict:
        """Return {name: check_fn} for all maintenance checks."""
        checks = {}
        checks['bt_bonded'] = lambda: health.check_bt_bonded(
            self.adapter_mac, self.phone_bt_mac, serial=self.serial)
        checks['bt_connected'] = lambda: health.check_bt_connected(
            self.adapter_mac, self.phone_bt_mac)
        checks['wifi'] = lambda: health.check_wifi_connected(self.serial)
        checks['device_owner'] = lambda: health.check_device_owner(self.serial)
        checks['restrictions'] = lambda: health.check_restrictions(self.serial)
        checks['snapshot_alive'] = lambda: health.check_snapshot_alive(self.serial)
        checks['port_forwards'] = lambda: health.check_port_forwards(
            self.serial, self.snapshot_port, self.internal_port)
        return checks

    def _run_heal(self, name: str):
        """Run heal for a given check name."""
        hs = self.status.heals.setdefault(name, HealStatus())

        # Rate-limit expensive heals (bt_bonded takes 30-150s per attempt)
        # Only cooldown after a successful heal — failed heals retry immediately
        if name == 'bt_bonded' and hs.last_at and hs.last_result == 'ok':
            from datetime import datetime, timezone
            try:
                elapsed = (datetime.now(timezone.utc) -
                           datetime.fromisoformat(hs.last_at)).total_seconds()
                if elapsed < 300:  # 5-minute cooldown
                    return
            except (ValueError, TypeError):
                pass

        hs.last_at = now_iso()
        hs.last_result = 'in_progress'
        hs.count_today += 1

        try:
            heal_ok = True
            if name == 'bt_bonded':
                result = heal.heal_bt_bonded(
                    self.serial, self.snapshot_url, report_error=self._report_error)
                if result and any(result):
                    self.adapter_mac, self.adapter_hci, self.phone_bt_mac = result
                    # Re-register with server so it gets updated MACs
                    register_with_server(
                        self.serial, self.snapshot_port, self.internal_port,
                        adapter_mac=self.adapter_mac, phone_bt_mac=self.phone_bt_mac)
                    # Verify the bond actually formed
                    heal_ok = health.check_bt_bonded(
                        self.adapter_mac, self.phone_bt_mac, serial=self.serial)
                else:
                    heal_ok = False
            elif name == 'bt_connected':
                heal_ok = heal.heal_bt_connected(self.adapter_mac, self.phone_bt_mac)
                if not heal_ok:
                    hs.consecutive_failures += 1
                    if hs.consecutive_failures >= 3:
                        self.log.warning(
                            f'bt_connected failed {hs.consecutive_failures} times consecutively '
                            f'— escalating to full re-pair (heal_bt_bonded)')
                        hs.consecutive_failures = 0
                        self._run_heal('bt_bonded')
                        return
                else:
                    hs.consecutive_failures = 0
            elif name == 'wifi':
                heal.heal_wifi(self.serial)
            elif name == 'device_owner':
                heal.heal_device_owner(self.serial)
            elif name == 'restrictions':
                heal.heal_restrictions(self.serial)
            elif name == 'snapshot_alive':
                heal.heal_snapshot_alive(self.serial, self.snapshot_port, self.internal_port)
            elif name == 'port_forwards':
                heal.heal_port_forwards(self.serial, self.snapshot_port, self.internal_port)
            hs.last_result = 'ok' if heal_ok else 'failed'
            hs.last_error = None if heal_ok else 'heal ran but check still fails'
        except Exception as e:
            hs.last_result = 'failed'
            hs.last_error = str(e)
            self.log.error(f'Heal {name} failed: {e}')

    def _start_pair_watcher(self):
        """Start background pair-dialog watcher thread if BT is active."""
        if os.environ.get('AUDIO_BACKEND') != 'bluetooth':
            return
        if self._pair_watcher_thread and self._pair_watcher_thread.is_alive():
            return
        self._pair_watcher_thread = threading.Thread(
            target=run_pair_dialog_watcher,
            args=(self.serial, self.snapshot_url, self.stopped),
            daemon=True,
            name=f'pair-watcher-{self.serial}',
        )
        self._pair_watcher_thread.start()
        self.log.info('Pair-dialog background watcher started')

    def run(self):
        """Full phone setup and monitoring loop. Blocks until disconnect."""
        self.run_setup()
        self.status.phase = 'monitoring'
        self._start_pair_watcher()
        push_status(self.status, self.phone_id, self.internal_port)

        while not self.stopped.is_set() and self.is_connected():
            self.run_maintenance_tick()
            push_status(self.status, self.phone_id, self.internal_port)
            self.stopped.wait(30)

        self.status.phase = 'stopped'
        self.log.info('Disconnected')
        deregister_from_server(self.phone_id)
        deregister_from_registry(self.registry_id)

    def stop(self):
        self.stopped.set()

    # --- CLI entry points (same code paths as auto-loop) ---

    def run_single_step(self, step_name: str):
        """Run a single setup step by name (for fleet-cli)."""
        step_map = {
            'screen': lambda: screen.configure_screen(self.serial),
            'silent': lambda: screen.configure_silent(self.serial),
            'device_owner': lambda: provisioning.provision_device_owner(self.serial),
            'snapshot': lambda: snapshot.start_snapshot_server(self.serial),
            'port_forwards': lambda: snapshot.setup_port_forwards(
                self.serial, self.snapshot_port, self.internal_port),
            'passcode': lambda: passcode.clear_passcode_if_set(
                self.serial, self._report_error),
            'wifi': lambda: wifi.connect_wifi(self.serial),
            'pair': lambda: allocate_and_pair_bluetooth(
                self.serial, self.snapshot_url, self._report_error),
            'restrictions': lambda: provisioning.apply_restrictions(self.serial),
        }
        fn = step_map.get(step_name)
        if not fn:
            raise ValueError(f'Unknown step: {step_name}. Available: {", ".join(step_map)}')
        return self._run_step(step_name, fn)

    def run_single_check(self, check_name: str) -> bool:
        """Run a single health check by name (for fleet-cli)."""
        checks = self._get_checks()
        fn = checks.get(check_name)
        if not fn:
            raise ValueError(f'Unknown check: {check_name}. Available: {", ".join(checks)}')
        return fn()

    def run_single_heal(self, heal_name: str):
        """Run a single heal by name (for fleet-cli)."""
        heals = list(self._get_checks().keys())
        if heal_name not in heals:
            raise ValueError(f'Unknown heal: {heal_name}. Available: {", ".join(heals)}')
        self._run_heal(heal_name)
