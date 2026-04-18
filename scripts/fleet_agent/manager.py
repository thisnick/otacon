"""FleetAgent — top-level manager. Replaces DeviceManager from device-monitor.py.

Handles ADB device discovery, dongle pool reporting, BlueZ agent registration,
reconnect watcher, and PhoneAgent supervision.
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

log = logging.getLogger('fleet-agent')

DISCONNECT_GRACE = 3


class FleetAgent:
    """Watches for ADB devices and spawns PhoneAgents."""

    def __init__(self):
        self.agents: dict[str, tuple[PhoneAgent, threading.Thread]] = {}
        self.port_allocator = PortAllocator(snapshot_start=9091, internal_start=8081)
        self._missing_count: dict[str, int] = {}
        self._lock = threading.Lock()
        self._glib_loop = None

    def _start_bluetooth_services(self):
        """Start BlueZ agent and reconnect watcher in a background thread."""
        if os.environ.get('AUDIO_BACKEND') != 'bluetooth':
            log.info('AUDIO_BACKEND != bluetooth, skipping BlueZ agent/reconnect')
            return

        ready = threading.Event()

        def run_glib():
            # Retry agent registration — bluetoothd may not be ready at container start
            for attempt in range(10):
                try:
                    loop = register_agent()
                    setup_reconnect_watcher()
                    self._glib_loop = loop
                    ready.set()
                    log.info('GLib main loop starting (BlueZ agent + reconnect watcher)')
                    loop.run()
                    return
                except Exception as e:
                    log.warning(f'BlueZ agent registration attempt {attempt+1}/10 failed: {e}')
                    time.sleep(2)
            log.error('BlueZ agent registration failed after 10 attempts')
            ready.set()  # unblock main thread even on failure

        t = threading.Thread(target=run_glib, daemon=True, name='bluez-glib')
        t.start()
        # Wait for agent registration (up to 25s) before phones start pairing
        ready.wait(timeout=25)
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

    def run(self):
        log.info('Fleet agent started')
        self._start_bluetooth_services()
        self.report_dongles()

        while True:
            current_serials = get_connected_serials()

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
