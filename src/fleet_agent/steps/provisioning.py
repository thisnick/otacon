import logging
import os
import re
import subprocess
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
        whitelist_deviceidle(serial)
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
    whitelist_deviceidle(serial)
    log.info(f'[{serial}] Device owner provisioned')


def whitelist_deviceidle(serial: str):
    """Add the kiosk to deviceidle whitelist so AlarmManager fires during Doze.
    Belt-and-suspenders alongside the device-owner permission grant; idempotent."""
    try:
        adb_shell(serial, f'dumpsys deviceidle whitelist +{DEVICE_OWNER_PKG}', timeout=5)
    except Exception as e:
        log.warning(f'[{serial}] deviceidle whitelist failed: {e}')


def _needs_apk_update(serial: str) -> bool:
    """Check if the installed kiosk APK version differs from the built APK."""
    if not os.path.exists(APK_PATH):
        return False
    # Get installed version code from phone
    try:
        dump = adb_shell(serial, f'dumpsys package {DEVICE_OWNER_PKG}', timeout=5)
        m = re.search(r'versionCode=(\d+)', dump)
        installed_ver = int(m.group(1)) if m else -1
    except Exception:
        return True  # can't read — reinstall to be safe
    # Get built APK version code via aapt2 or aapt
    for tool in ('aapt2', 'aapt'):
        try:
            r = subprocess.run(
                [tool, 'dump', 'badging', APK_PATH],
                capture_output=True, text=True, timeout=5)
            if r.returncode == 0:
                m = re.search(r"versionCode='(\d+)'", r.stdout)
                if m:
                    built_ver = int(m.group(1))
                    if installed_ver == built_ver:
                        return False
                    log.info(f'[{serial}] APK version mismatch: installed={installed_ver} built={built_ver}')
                    return True
        except (FileNotFoundError, subprocess.TimeoutExpired):
            continue
    # If we can't read the built APK version, reinstall to be safe
    return True


def apply_restrictions(serial: str):
    if not is_device_owner_set(serial):
        return
    # Only reinstall the APK if the version on the phone is outdated —
    # avoids thrashing during frequent heal cycles (every 30s if check fails).
    if _needs_apk_update(serial):
        result = adb(serial, 'install', '-r', APK_PATH, timeout=30)
        if 'Success' in result:
            log.info(f'[{serial}] Kiosk APK updated before applying restrictions')
            # Re-grant runtime permissions — reinstall can reset dangerous
            # permission state (e.g. BLUETOOTH_CONNECT) on Android 12+.
            grant_permissions(serial)
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
