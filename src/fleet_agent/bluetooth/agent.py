"""BlueZ auto-accept pairing agent.

Auto-accepts all pairing requests (KeyboardDisplay capability),
trusts paired devices, keeps adapters pairable.  All adapters
default to Discoverable=false; only the specific adapter being
paired is temporarily made discoverable during the pair flow.
"""

import logging
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


class AutoAcceptAgent(dbus.service.Object):
    @dbus.service.method(AGENT_IFACE, in_signature="", out_signature="")
    def Release(self):
        log.info("Agent released")

    @dbus.service.method(AGENT_IFACE, in_signature="os", out_signature="")
    def AuthorizeService(self, device, uuid):
        log.info(f"AuthorizeService: {device} {uuid}")

    @dbus.service.method(AGENT_IFACE, in_signature="o", out_signature="s")
    def RequestPinCode(self, device):
        log.info(f"RequestPinCode: {device}")
        return "0000"

    @dbus.service.method(AGENT_IFACE, in_signature="o", out_signature="u")
    def RequestPasskey(self, device):
        log.info(f"RequestPasskey: {device}")
        return dbus.UInt32(0)

    @dbus.service.method(AGENT_IFACE, in_signature="ouq", out_signature="")
    def DisplayPasskey(self, device, passkey, entered):
        log.info(f"DisplayPasskey: {device} {passkey:06d} entered={entered}")

    @dbus.service.method(AGENT_IFACE, in_signature="os", out_signature="")
    def DisplayPinCode(self, device, pincode):
        log.info(f"DisplayPinCode: {device} {pincode}")

    @dbus.service.method(AGENT_IFACE, in_signature="ou", out_signature="")
    def RequestConfirmation(self, device, passkey):
        log.info(f"RequestConfirmation: {device} {passkey:06d} -> auto-accepting")
        _trust_device(device)

    @dbus.service.method(AGENT_IFACE, in_signature="o", out_signature="")
    def RequestAuthorization(self, device):
        log.info(f"RequestAuthorization: {device} -> auto-accepting")
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
    """Set Discoverable=false on ALL adapters (including hci0).

    Called at startup to ensure no adapter broadcasts its name.
    Adapters remain Pairable so bonded devices can still reconnect
    via known BD_ADDR.
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
            ("Pairable",            True),
            ("PairableTimeout",     dbus.UInt32(0)),
        ]:
            try:
                props.Set(ADAPTER_IFACE, prop, val)
            except dbus.exceptions.DBusException as e:
                log.info(f"Adapter {path} {prop} set skipped: {e.get_dbus_name()}")
        try:
            alias = props.Get(ADAPTER_IFACE, "Alias")
            discoverable = bool(props.Get(ADAPTER_IFACE, "Discoverable"))
            log.info(f"Adapter {path} ({alias}) silenced: Discoverable={discoverable}")
        except Exception:
            pass
        found = True
    if not found:
        log.warning("No Bluetooth adapter found")


def register_agent():
    """Register the BlueZ pairing agent and configure adapters.

    Returns the GLib.MainLoop so the caller can run it in a thread.
    Retries BlueZ registration internally (bluetoothd may not be ready at
    container start), but only creates the D-Bus object once.
    """
    import time as _time

    dbus.mainloop.glib.DBusGMainLoop(set_as_default=True)
    bus = dbus.SystemBus()

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
