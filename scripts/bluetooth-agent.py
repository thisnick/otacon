#!/usr/bin/env python3
"""BlueZ auto-accept pairing agent.
- Auto-accepts all pairing requests (NoInputNoOutput)
- Trusts paired devices
- Keeps adapter discoverable and pairable
BlueALSA handles all HFP audio routing — no PulseAudio needed here.
"""

import dbus
import dbus.mainloop.glib
import dbus.service
from gi.repository import GLib

BUS_NAME        = "org.bluez"
AGENT_IFACE     = "org.bluez.Agent1"
AGENT_MGR_IFACE = "org.bluez.AgentManager1"
ADAPTER_IFACE   = "org.bluez.Adapter1"
DEVICE_IFACE    = "org.bluez.Device1"
AGENT_PATH      = "/otacon/agent"


class AutoAcceptAgent(dbus.service.Object):
    @dbus.service.method(AGENT_IFACE, in_signature="", out_signature="")
    def Release(self):
        print("Agent released")

    @dbus.service.method(AGENT_IFACE, in_signature="os", out_signature="")
    def AuthorizeService(self, device, uuid):
        print(f"AuthorizeService: {device} {uuid}")

    @dbus.service.method(AGENT_IFACE, in_signature="o", out_signature="s")
    def RequestPinCode(self, device):
        print(f"RequestPinCode: {device}")
        return "0000"

    @dbus.service.method(AGENT_IFACE, in_signature="o", out_signature="u")
    def RequestPasskey(self, device):
        print(f"RequestPasskey: {device}")
        return dbus.UInt32(0)

    @dbus.service.method(AGENT_IFACE, in_signature="ouq", out_signature="")
    def DisplayPasskey(self, device, passkey, entered):
        print(f"DisplayPasskey: {device} {passkey:06d} entered={entered}")

    @dbus.service.method(AGENT_IFACE, in_signature="os", out_signature="")
    def DisplayPinCode(self, device, pincode):
        print(f"DisplayPinCode: {device} {pincode}")

    @dbus.service.method(AGENT_IFACE, in_signature="ou", out_signature="")
    def RequestConfirmation(self, device, passkey):
        print(f"RequestConfirmation: {device} {passkey:06d} -> auto-accepting")
        trust_device(device)

    @dbus.service.method(AGENT_IFACE, in_signature="o", out_signature="")
    def RequestAuthorization(self, device):
        print(f"RequestAuthorization: {device} -> auto-accepting")
        trust_device(device)

    @dbus.service.method(AGENT_IFACE, in_signature="", out_signature="")
    def Cancel(self):
        print("Pairing cancelled")


def trust_device(device_path):
    try:
        bus = dbus.SystemBus()
        props = dbus.Interface(
            bus.get_object(BUS_NAME, device_path),
            "org.freedesktop.DBus.Properties",
        )
        props.Set(DEVICE_IFACE, "Trusted", True)
        print(f"Trusted: {device_path}")
    except Exception as e:
        print(f"Failed to trust {device_path}: {e}")


def on_properties_changed(interface, changed, invalidated, path=None):
    if interface != DEVICE_IFACE:
        return
    if "Connected" in changed:
        state = "connected" if bool(changed["Connected"]) else "disconnected"
        print(f"Device {state}: {path}")


def set_adapter_discoverable():
    bus = dbus.SystemBus()
    manager = dbus.Interface(
        bus.get_object(BUS_NAME, "/"),
        "org.freedesktop.DBus.ObjectManager",
    )
    for path, interfaces in manager.GetManagedObjects().items():
        if ADAPTER_IFACE in interfaces:
            props = dbus.Interface(
                bus.get_object(BUS_NAME, path),
                "org.freedesktop.DBus.Properties",
            )
            props.Set(ADAPTER_IFACE, "Discoverable",        True)
            props.Set(ADAPTER_IFACE, "DiscoverableTimeout", dbus.UInt32(0))
            props.Set(ADAPTER_IFACE, "Pairable",            True)
            props.Set(ADAPTER_IFACE, "PairableTimeout",     dbus.UInt32(0))
            alias = props.Get(ADAPTER_IFACE, "Alias")
            print(f"Adapter {path} ({alias}) set to discoverable + pairable")
            return
    print("No Bluetooth adapter found")


def main():
    dbus.mainloop.glib.DBusGMainLoop(set_as_default=True)
    bus = dbus.SystemBus()

    agent = AutoAcceptAgent(bus, AGENT_PATH)
    agent_mgr = dbus.Interface(
        bus.get_object(BUS_NAME, "/org/bluez"),
        AGENT_MGR_IFACE,
    )
    agent_mgr.RegisterAgent(AGENT_PATH, "NoInputNoOutput")
    agent_mgr.RequestDefaultAgent(AGENT_PATH)
    print("Bluetooth auto-accept agent registered")

    set_adapter_discoverable()

    bus.add_signal_receiver(
        on_properties_changed,
        signal_name="PropertiesChanged",
        dbus_interface="org.freedesktop.DBus.Properties",
        path_keyword="path",
    )
    print("Listening for device connections...")

    GLib.MainLoop().run()


if __name__ == "__main__":
    main()
