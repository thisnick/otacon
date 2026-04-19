"""BlueZ pairing agent with per-adapter MAC allowlist.

Accepts pairing requests only when the peer MAC matches the phone
assigned to that adapter in phones.json.  All other pair attempts
are rejected with org.bluez.Error.Rejected, preventing cross-dongle
bonds that are very hard to clean up (especially on Samsung Android
16+ where removeBond() silently fails).

Adapters default to Pairable=false; the pair flow in pair.py
temporarily sets Pairable=true on the specific adapter being paired.
"""

import json
import logging
import os
import re

import dbus
import dbus.mainloop.glib
import dbus.service
from gi.repository import GLib

log = logging.getLogger('fleet-agent')

BUS_NAME        = "org.bluez"
AGENT_IFACE     = "org.bluez.Agent1"
AGENT_MGR_IFACE = "org.bluez.AgentManager1"
ADAPTER_IFACE   = "org.bluez.Adapter1"
DEVICE_IFACE    = "org.bluez.Device1"
AGENT_PATH      = "/otacon/agent"

PHONES_JSON_PATH = os.environ.get('PHONES_CONFIG', '/data/otacon/phones.json')

# {adapter_mac_upper: phone_bt_mac_upper}  — loaded from phones.json
_adapter_allowlist: dict[str, str] = {}


def _load_allowlist():
    """Reload the per-adapter MAC allowlist from phones.json."""
    global _adapter_allowlist
    try:
        with open(PHONES_JSON_PATH) as f:
            phones = json.load(f)
        mapping = {}
        for p in phones:
            adapter = (p.get('adapter_mac') or '').upper()
            phone_bt = (p.get('phone_bt_mac') or '').upper()
            if adapter and phone_bt:
                mapping[adapter] = phone_bt
        _adapter_allowlist = mapping
        log.info(f'BT agent allowlist loaded: {len(mapping)} adapter→phone mappings')
    except (FileNotFoundError, json.JSONDecodeError) as e:
        log.warning(f'BT agent allowlist load failed: {e}')


def _parse_device_path(device_path: str) -> tuple[str | None, str | None]:
    """Extract (hci_name, peer_mac) from a BlueZ device path.

    Example: /org/bluez/hci3/dev_4C_2E_5E_D2_D6_00
    Returns: ('hci3', '4C:2E:5E:D2:D6:00')
    """
    m = re.match(r'.*/bluez/(hci\d+)/dev_([0-9A-F_]+)', device_path, re.I)
    if not m:
        return None, None
    hci = m.group(1)
    peer_mac = m.group(2).replace('_', ':').upper()
    return hci, peer_mac


def _get_adapter_mac(hci_name: str) -> str | None:
    """Look up the BD_ADDR of a local adapter by its hci name."""
    try:
        bus = dbus.SystemBus()
        props = dbus.Interface(
            bus.get_object(BUS_NAME, f'/org/bluez/{hci_name}'),
            'org.freedesktop.DBus.Properties',
        )
        return str(props.Get(ADAPTER_IFACE, 'Address')).upper()
    except Exception:
        return None


def _check_allowlist(device_path: str) -> bool:
    """Return True if this peer is allowed to pair on this adapter.

    Re-reads phones.json each call (cross-process; pair.py may have
    updated the file since the last check).

    If the allowlist is empty (phones.json not yet populated with BT
    MACs), all requests are accepted to avoid blocking initial setup.
    """
    _load_allowlist()
    if not _adapter_allowlist:
        return True  # no allowlist yet — accept all (initial provisioning)

    hci, peer_mac = _parse_device_path(device_path)
    if not hci or not peer_mac:
        log.warning(f'BT agent: cannot parse device path {device_path} — rejecting')
        return False

    adapter_mac = _get_adapter_mac(hci)
    if not adapter_mac:
        log.warning(f'BT agent: cannot get MAC for {hci} — rejecting')
        return False

    expected = _adapter_allowlist.get(adapter_mac)
    if expected is None:
        # Adapter not in phones.json — no phone assigned, reject
        log.warning(f'BT agent: adapter {adapter_mac} ({hci}) has no phone assigned — '
                     f'rejecting pair from {peer_mac}')
        return False

    if peer_mac != expected:
        log.warning(f'BT agent: REJECTING cross-dongle pair — '
                     f'{peer_mac} tried to pair on {adapter_mac} ({hci}), '
                     f'expected {expected}')
        return False

    log.info(f'BT agent: allowing pair — {peer_mac} on {adapter_mac} ({hci})')
    return True


REJECTED = dbus.exceptions.DBusException(
    'org.bluez.Error.Rejected',
    'Peer MAC not in allowlist for this adapter',
)


class AutoAcceptAgent(dbus.service.Object):
    @dbus.service.method(AGENT_IFACE, in_signature="", out_signature="")
    def Release(self):
        log.info("Agent released")

    @dbus.service.method(AGENT_IFACE, in_signature="os", out_signature="")
    def AuthorizeService(self, device, uuid):
        log.info(f"AuthorizeService: {device} {uuid}")
        if not _check_allowlist(device):
            raise REJECTED

    @dbus.service.method(AGENT_IFACE, in_signature="o", out_signature="s")
    def RequestPinCode(self, device):
        log.info(f"RequestPinCode: {device}")
        if not _check_allowlist(device):
            raise REJECTED
        return "0000"

    @dbus.service.method(AGENT_IFACE, in_signature="o", out_signature="u")
    def RequestPasskey(self, device):
        log.info(f"RequestPasskey: {device}")
        if not _check_allowlist(device):
            raise REJECTED
        return dbus.UInt32(0)

    @dbus.service.method(AGENT_IFACE, in_signature="ouq", out_signature="")
    def DisplayPasskey(self, device, passkey, entered):
        log.info(f"DisplayPasskey: {device} {passkey:06d} entered={entered}")
        if not _check_allowlist(device):
            raise REJECTED

    @dbus.service.method(AGENT_IFACE, in_signature="os", out_signature="")
    def DisplayPinCode(self, device, pincode):
        log.info(f"DisplayPinCode: {device} {pincode}")
        if not _check_allowlist(device):
            raise REJECTED

    @dbus.service.method(AGENT_IFACE, in_signature="ou", out_signature="")
    def RequestConfirmation(self, device, passkey):
        log.info(f"RequestConfirmation: {device} {passkey:06d}")
        if not _check_allowlist(device):
            raise REJECTED
        log.info(f"RequestConfirmation: auto-accepting")
        _trust_device(device)

    @dbus.service.method(AGENT_IFACE, in_signature="o", out_signature="")
    def RequestAuthorization(self, device):
        log.info(f"RequestAuthorization: {device}")
        if not _check_allowlist(device):
            raise REJECTED
        log.info(f"RequestAuthorization: auto-accepting")
        _trust_device(device)

    @dbus.service.method(AGENT_IFACE, in_signature="", out_signature="")
    def Cancel(self):
        log.info("Pairing cancelled")


def _trust_device(device_path):
    try:
        bus = dbus.SystemBus()
        props = dbus.Interface(
            bus.get_object(BUS_NAME, device_path),
            "org.freedesktop.DBus.Properties",
        )
        props.Set(DEVICE_IFACE, "Trusted", True)
        log.info(f"Trusted: {device_path}")
    except Exception as e:
        log.warning(f"Failed to trust {device_path}: {e}")


def _on_properties_changed(interface, changed, invalidated, path=None):
    if interface != DEVICE_IFACE:
        return
    if "Connected" in changed:
        state = "connected" if bool(changed["Connected"]) else "disconnected"
        log.info(f"Device {state}: {path}")


def silence_all_adapters():
    """Set Discoverable=false and Pairable=false on ALL adapters.

    Called at startup to ensure no adapter broadcasts its name and
    no adapter accepts unsolicited pair requests.  The pair flow in
    pair.py temporarily enables Pairable+Discoverable on the specific
    adapter being paired, then disables both afterward.
    """
    bus = dbus.SystemBus()
    manager = dbus.Interface(
        bus.get_object(BUS_NAME, "/"),
        "org.freedesktop.DBus.ObjectManager",
    )
    found = False
    items = sorted(manager.GetManagedObjects().items(), key=lambda kv: kv[0])
    for path, interfaces in items:
        if ADAPTER_IFACE not in interfaces:
            continue
        props = dbus.Interface(
            bus.get_object(BUS_NAME, path),
            "org.freedesktop.DBus.Properties",
        )
        try:
            mac = str(props.Get(ADAPTER_IFACE, "Address"))
            suffix = mac.replace(':', '')[-4:].upper()
            alias_target = f"Otacon-{suffix}"
            current_alias = str(props.Get(ADAPTER_IFACE, "Alias"))
            if current_alias != alias_target:
                props.Set(ADAPTER_IFACE, "Alias", alias_target)
                log.info(f"Adapter {path} renamed: {current_alias} -> {alias_target}")
        except Exception as e:
            log.warning(f"Adapter {path} alias set failed: {e}")
        for prop, val in [
            ("Discoverable",        False),
            ("DiscoverableTimeout", dbus.UInt32(0)),
            ("Pairable",            False),
            ("PairableTimeout",     dbus.UInt32(0)),
        ]:
            try:
                props.Set(ADAPTER_IFACE, prop, val)
            except dbus.exceptions.DBusException as e:
                log.info(f"Adapter {path} {prop} set skipped: {e.get_dbus_name()}")
        try:
            alias = props.Get(ADAPTER_IFACE, "Alias")
            discoverable = bool(props.Get(ADAPTER_IFACE, "Discoverable"))
            pairable = bool(props.Get(ADAPTER_IFACE, "Pairable"))
            log.info(f"Adapter {path} ({alias}) locked down: "
                     f"Discoverable={discoverable} Pairable={pairable}")
        except Exception:
            pass
        found = True
    if not found:
        log.warning("No Bluetooth adapter found")


def reload_allowlist():
    """Public entry point to refresh the MAC allowlist from phones.json.

    Called by the pair flow after saving a new dongle assignment so that
    the agent immediately recognizes the new phone→adapter mapping.
    """
    _load_allowlist()


def register_agent():
    """Register the BlueZ pairing agent and configure adapters.

    Returns the GLib.MainLoop so the caller can run it in a thread.
    Retries BlueZ registration internally (bluetoothd may not be ready at
    container start), but only creates the D-Bus object once.
    """
    import time as _time

    dbus.mainloop.glib.DBusGMainLoop(set_as_default=True)
    bus = dbus.SystemBus()

    # Load per-adapter MAC allowlist from phones.json
    _load_allowlist()

    # Create the D-Bus object once — this claims the path on the bus connection
    agent = AutoAcceptAgent(bus, AGENT_PATH)

    # Retry BlueZ registration (bluetoothd may still be starting)
    for attempt in range(15):
        try:
            agent_mgr = dbus.Interface(
                bus.get_object(BUS_NAME, "/org/bluez"),
                AGENT_MGR_IFACE,
            )
            agent_mgr.RegisterAgent(AGENT_PATH, "KeyboardDisplay")
            agent_mgr.RequestDefaultAgent(AGENT_PATH)
            log.info("Bluetooth auto-accept agent registered")
            break
        except dbus.exceptions.DBusException as e:
            log.warning(f'BlueZ agent registration attempt {attempt+1}/15: {e}')
            _time.sleep(2)
    else:
        raise RuntimeError('BlueZ agent registration failed after 15 attempts')

    silence_all_adapters()

    bus.add_signal_receiver(
        _on_properties_changed,
        signal_name="PropertiesChanged",
        dbus_interface="org.freedesktop.DBus.Properties",
        path_keyword="path",
    )
    log.info("Listening for device connections...")

    return GLib.MainLoop()
