import logging
import os

from ..util.adb import adb_shell

log = logging.getLogger('fleet-agent')


def clear_passcode_if_set(serial: str, report_error=None):
    """Detect if the phone has a screen-lock passcode and clear it."""
    status = adb_shell(
        serial,
        "content query --uri 'content://com.otacon.kiosk/lock/status'"
    )
    if not status:
        return
    if 'is_secure=true' not in status:
        return
    log.warning(f'[{serial}] Passcode detected -- attempting clear...')

    env_key = f'PHONE_PIN_{serial}'
    pins = os.environ.get(env_key, '').split(',')
    for pin in pins:
        pin = pin.strip()
        if not pin:
            continue
        result = adb_shell(serial, f'locksettings clear --old {pin}')
        if result and 'cleared' in result.lower():
            log.info(f'[{serial}] Passcode cleared via locksettings (pin matched)')
            return

    result = adb_shell(
        serial,
        "content query --uri 'content://com.otacon.kiosk/lock/clear'"
    )
    if result and 'ok=true' in result:
        log.info(f'[{serial}] Passcode cleared via device-owner token')
        return

    for pin in pins:
        pin = pin.strip()
        if not pin:
            continue
        activate = adb_shell(
            serial,
            f"content query --uri 'content://com.otacon.kiosk/lock/activate?password={pin}'"
        )
        if activate and 'token_activated=true' in activate:
            log.info(f'[{serial}] Token activated with known PIN')
            result = adb_shell(
                serial,
                "content query --uri 'content://com.otacon.kiosk/lock/clear'"
            )
            if result and 'ok=true' in result:
                log.info(f'[{serial}] Passcode cleared via token after activation')
                return

    log.error(f'[{serial}] Failed to clear passcode: {result}')
    if report_error:
        report_error('password.locked_no_token',
                      f'Cannot clear passcode -- token not activated')
