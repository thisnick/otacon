import logging

from ..util.adb import adb_shell

log = logging.getLogger('fleet-agent')


def gather_identity(serial: str) -> dict:
    """Collect phone identity for registry registration."""
    model = adb_shell(serial, 'getprop ro.product.model')
    bt_mac = adb_shell(serial, 'settings get secure bluetooth_address')
    imei = adb_shell(
        serial,
        "service call iphonesubinfo 1 | grep -o '[0-9a-f]\\{8\\}' | tail -n+2 | "
        "while read a; do echo -n \"\\u${a:4:4}\\u${a:0:4}\"; done"
    )
    phone_number = adb_shell(
        serial,
        "content query --uri content://com.otacon.kiosk/device/phone-number "
        "2>/dev/null | grep -o 'number=.*' | cut -d= -f2"
    )
    return {
        'adb_serial': serial,
        'phone_number': phone_number or None,
        'model': model or None,
        'bt_mac': bt_mac if bt_mac and bt_mac != 'null' else None,
        'imei': imei if imei and len(imei) >= 14 else None,
    }
