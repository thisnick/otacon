import logging
import os
import time

from ..util.adb import adb, adb_shell

log = logging.getLogger('fleet-agent')

DEVICE_OWNER_PKG = 'com.otacon.kiosk'
DEVICE_OWNER_RECEIVER = f'{DEVICE_OWNER_PKG}/.DeviceOwnerReceiver'
APK_PATH = '/opt/otacon-kiosk.apk'

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


def is_device_owner_set(serial: str) -> bool:
    output = adb_shell(serial, 'dpm list-owners')
    return DEVICE_OWNER_PKG in output


def grant_permissions(serial: str):
    for perm in RUNTIME_PERMISSIONS:
        adb_shell(serial, f'pm grant {DEVICE_OWNER_PKG} {perm}')


def provision_device_owner(serial: str):
    if is_device_owner_set(serial):
        log.info(f'[{serial}] Device owner already set')
        if os.path.exists(APK_PATH):
            result = adb(serial, 'install', '-r', APK_PATH, timeout=30)
            if 'Success' in result:
                log.info(f'[{serial}] APK updated')
        grant_permissions(serial)
        adb_shell(
            serial,
            f'am broadcast -a {DEVICE_OWNER_PKG}.CLEAR_RESTRICTIONS '
            f'-n {DEVICE_OWNER_PKG}/.BootReceiver'
        )
        return

    log.info(f'[{serial}] Device owner not set -- provisioning...')
    account_dump = adb_shell(serial, 'dumpsys account')
    account_count = account_dump.count('Account {')
    if account_count > 0:
        log.error(f'[{serial}] Phone has {account_count} account(s). Factory reset required.')
        return

    if not os.path.exists(APK_PATH):
        log.warning(f'[{serial}] {APK_PATH} not found -- skipping')
        return

    adb(serial, 'install', '-r', APK_PATH, timeout=30)
    adb_shell(serial, f'dpm set-device-owner {DEVICE_OWNER_RECEIVER}')

    for attempt in range(1, 6):
        if is_device_owner_set(serial):
            log.info(f'[{serial}] Device owner verified on attempt {attempt}')
            break
        log.warning(f'[{serial}] Device owner not set after attempt {attempt}/5 -- retrying in 5s')
        time.sleep(5)
        adb_shell(serial, f'dpm set-device-owner {DEVICE_OWNER_RECEIVER}')
    else:
        log.error(f'[{serial}] Device owner failed to set after 5 attempts')
        return

    adb_shell(serial, f'cmd notification allow_listener {DEVICE_OWNER_PKG}/.OtaconNotificationListener')
    grant_permissions(serial)
    log.info(f'[{serial}] Device owner provisioned')


def apply_restrictions(serial: str):
    if not is_device_owner_set(serial):
        return
    # Ensure the kiosk APK is up-to-date before sending the broadcast —
    # an old APK may have a stale USER_RESTRICTIONS list.
    if os.path.exists(APK_PATH):
        result = adb(serial, 'install', '-r', APK_PATH, timeout=30)
        if 'Success' in result:
            log.info(f'[{serial}] Kiosk APK updated before applying restrictions')
    adb_shell(
        serial,
        f'am broadcast -a {DEVICE_OWNER_PKG}.CLEAR_RESTRICTIONS '
        f'-n {DEVICE_OWNER_PKG}/.BootReceiver'
    )
    time.sleep(2)
    adb_shell(
        serial,
        f'am broadcast -a {DEVICE_OWNER_PKG}.APPLY_RESTRICTIONS '
        f'-n {DEVICE_OWNER_PKG}/.BootReceiver'
    )
    time.sleep(1)
    # Verify restrictions were actually applied
    dumpsys = adb_shell(serial, 'dumpsys user', timeout=5)
    if 'no_factory_reset' not in dumpsys:
        log.warning(f'[{serial}] Restrictions may not have taken effect — '
                    f'no_factory_reset missing from dumpsys user after apply')
    adb_shell(serial, f'cmd notification allow_listener {DEVICE_OWNER_PKG}/.OtaconNotificationListener')
    log.info(f'[{serial}] Restrictions applied')
