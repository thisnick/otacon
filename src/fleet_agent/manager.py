"""FleetAgent — top-level manager. Replaces DeviceManager from device-monitor.py.

Handles ADB device discovery, dongle pool reporting, BlueZ agent registration,
reconnect watcher, PhoneAgent supervision, and loss detection/recovery.
"""

import logging
import os
import threading
import time

from .util.adb import get_connected_serials
from .util.http import http_post
from .util.ports import PortAllocator
from .phone.agent import PhoneAgent
from .bluetooth.dongle import enum_dongles, load_dongle_assignments
from .bluetooth.agent import register_agent
from .bluetooth.reconnect import setup_reconnect_watcher
from .loss_handler import LOSS_TIMEOUT_SECONDS, handle_phone_lost, handle_dongle_lost

log = logging.getLogger('fleet-agent')

DISCONNECT_GRACE = 3
LOSS_SWEEP_INTERVAL = 30  # seconds between loss-detection sweeps


class FleetAgent:
    """Watches for ADB devices and spawns PhoneAgents."""

    def __init__(self, *, time_fn=None):
        self.agents: dict[str, tuple[PhoneAgent, threading.Thread]] = {}
        self.port_allocator = PortAllocator(snapshot_start=9091, internal_start=8081)
        self._missing_count: dict[str, int] = {}
        self._lock = threading.Lock()
        self._glib_loop = None
        # Last-seen timestamps: {serial: monotonic_time} / {mac: monotonic_time}
        self.phone_last_seen: dict[str, float] = {}
        self.dongle_last_seen: dict[str, float] = {}
        self._time_fn = time_fn or time.monotonic
        self._last_sweep: float = 0

    def _start_bluetooth_services(self):
        """Start BlueZ agent and reconnect watcher in a background thread."""
        if os.environ.get('AUDIO_BACKEND') != 'bluetooth':
            log.info('AUDIO_BACKEND != bluetooth, skipping BlueZ agent/reconnect')
            return

        ready = threading.Event()

        def run_glib():
            try:
                loop = register_agent()
                setup_reconnect_watcher()
                self._glib_loop = loop
                ready.set()
                log.info('GLib main loop starting (BlueZ agent + reconnect watcher)')
                loop.run()
            except Exception as e:
                log.error(f'BlueZ services failed: {e}')
                ready.set()  # unblock main thread even on failure

        t = threading.Thread(target=run_glib, daemon=True, name='bluez-glib')
        t.start()
        # Wait for agent registration (up to 35s) before phones start pairing
        ready.wait(timeout=35)
        if self._glib_loop is None:
            log.error('BlueZ agent not running — Bluetooth pairing will fail')

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
        dongle_list = []
        for mac, hci in dongles.items():
            phone_id = None
            for serial, assigned_mac in assignments.items():
                if assigned_mac and assigned_mac.upper() == mac:
                    with self._lock:
                        if serial in self.agents:
                            phone_id = self.agents[serial][0].phone_id
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

    def _update_last_seen(self, current_serials: set[str]) -> None:
        """Update phone_last_seen for all currently visible phones."""
        now = self._time_fn()
        for serial in current_serials:
            self.phone_last_seen[serial] = now

    def _update_dongle_last_seen(self) -> None:
        """Update dongle_last_seen for all currently visible dongles."""
        now = self._time_fn()
        live_dongles = enum_dongles()
        for mac in live_dongles:
            self.dongle_last_seen[mac.upper()] = now

    def loss_sweep(self) -> None:
        """Check for phones/dongles absent longer than LOSS_TIMEOUT_SECONDS.

        Runs every LOSS_SWEEP_INTERVAL seconds. On detection:
        - Phone lost -> free its dongle to spare pool
        - Dongle lost -> reassign orphaned phone to a spare dongle

        Note: We iterate phone_last_seen (not self.agents) because the agent
        is removed from self.agents after DISCONNECT_GRACE (~6s), well before
        the 5-min loss timeout elapses. phone_last_seen retains the stale
        timestamp so we can detect the loss.
        """
        now = self._time_fn()
        if now - self._last_sweep < LOSS_SWEEP_INTERVAL:
            return
        self._last_sweep = now

        # Check for lost phones — iterate phone_last_seen, not self.agents
        lost_phones = []
        for serial, last_seen in list(self.phone_last_seen.items()):
            if (now - last_seen) > LOSS_TIMEOUT_SECONDS:
                lost_phones.append(serial)

        for serial in lost_phones:
            log.warning(f'Phone {serial} absent >{LOSS_TIMEOUT_SECONDS}s — triggering loss handler')
            self.phone_last_seen.pop(serial, None)
            handle_phone_lost(serial, self)

        # Check for lost dongles
        assignments = load_dongle_assignments()
        assigned_macs = set(mac.upper() for mac in assignments.values() if mac)
        lost_dongles = []
        for mac in assigned_macs:
            last_seen = self.dongle_last_seen.get(mac)
            if last_seen is not None and (now - last_seen) > LOSS_TIMEOUT_SECONDS:
                lost_dongles.append(mac)

        for mac in lost_dongles:
            log.warning(f'Dongle {mac} absent >{LOSS_TIMEOUT_SECONDS}s — triggering loss handler')
            self.dongle_last_seen.pop(mac, None)
            handle_dongle_lost(mac, self)

    def run(self):
        log.info('Fleet agent started')
        self._start_bluetooth_services()
        self.report_dongles()

        while True:
            current_serials = get_connected_serials()

            # Update last-seen timestamps
            self._update_last_seen(current_serials)
            self._update_dongle_last_seen()

            with self._lock:
                # Start agents for new devices
                for serial in current_serials - set(self.agents.keys()):
                    snapshot_port, internal_port, display_num, vnc_port = \
                        self.port_allocator.allocate(serial)
                    agent = PhoneAgent(serial, snapshot_port, internal_port,
                                        display_num, vnc_port)
                    thread = threading.Thread(target=agent.run, daemon=True,
                                              name=f'phone-{serial}')
                    thread.start()
                    self.agents[serial] = (agent, thread)
                    self._missing_count.pop(serial, None)
                    log.info(f'Started agent for {serial}')

                # Clean up disconnected devices (with grace period)
                for serial in list(self.agents.keys()):
                    if serial not in current_serials:
                        self._missing_count[serial] = \
                            self._missing_count.get(serial, 0) + 1
                        if self._missing_count[serial] >= DISCONNECT_GRACE:
                            agent, thread = self.agents.pop(serial)
                            agent.stop()
                            self.port_allocator.release(agent.snapshot_port)
                            self._missing_count.pop(serial, None)
                            log.info(f'Removed agent for {serial} (missing {DISCONNECT_GRACE} checks)')
                    else:
                        self._missing_count.pop(serial, None)

            # Run loss sweep (every LOSS_SWEEP_INTERVAL seconds)
            self.loss_sweep()

            time.sleep(2)

    def get_agent(self, phone_id_or_serial: str) -> PhoneAgent | None:
        """Look up a PhoneAgent by serial or phone_id."""
        with self._lock:
            # Try serial first
            if phone_id_or_serial in self.agents:
                return self.agents[phone_id_or_serial][0]
            # Try phone_id
            for serial, (agent, _) in self.agents.items():
                if agent.phone_id == phone_id_or_serial:
                    return agent
        return None

    def list_agents(self) -> list[PhoneAgent]:
        with self._lock:
            return [agent for agent, _ in self.agents.values()]
