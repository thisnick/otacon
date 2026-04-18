import logging
import os

from ..util.adb import adb_shell

log = logging.getLogger('fleet-agent')


def configure_screen(serial: str):
    """Configure screen settings: stay awake timeout, brightness, portrait lock."""
    log.info(f'[{serial}] Configuring screen...')
    adb_shell(serial, 'settings put global stay_on_while_plugged_in 0')
    adb_shell(serial, 'settings put system screen_off_timeout 300000')  # 5 min
    adb_shell(serial, 'settings put system screen_brightness_mode 1')
    adb_shell(serial, 'settings put system accelerometer_rotation 0')
    adb_shell(serial, 'settings put system user_rotation 0')
    adb_shell(serial, 'locksettings set-password-quality 0')
    adb_shell(serial, 'svc data disable')
    adb_shell(serial, 'pm disable-user --user 0 com.google.android.apps.messaging')


def parse_stream_max(dumpsys_output: str, stream: str) -> int | None:
    """Parse max volume for a stream from dumpsys audio output. Pure function."""
    names = {'0': 'STREAM_VOICE_CALL', '3': 'STREAM_MUSIC'}
    name = names.get(stream)
    if not name:
        return None
    marker = f'- {name}:'
    idx = dumpsys_output.find(marker)
    if idx < 0:
        return None
    tail = dumpsys_output[idx:idx + 400]
    for line in tail.splitlines():
        line = line.strip()
        if line.startswith('Max:'):
            try:
                return int(line.split(':', 1)[1].strip().split()[0])
            except (ValueError, IndexError):
                return None
    return None


def _stream_max(serial: str, stream: str) -> int | None:
    """Look up the max index for an audio stream from dumpsys."""
    out = adb_shell(serial, 'dumpsys audio')
    return parse_stream_max(out, stream)


def configure_silent(serial: str):
    """Mute alerts, max music + voice for BT audio routing."""
    log.info(f'[{serial}] Setting silent mode...')
    adb_shell(serial, 'cmd notification set_dnd alarms')
    for stream in ('3', '0'):  # MUSIC, VOICE_CALL
        mx = _stream_max(serial, stream)
        if mx is not None:
            adb_shell(serial, f'cmd media_session volume --stream {stream} --set {mx}')
            log.info(f'[{serial}]   stream {stream} -> {mx}')
    adb_shell(serial, 'settings put system vibrate_when_ringing 0')
    adb_shell(serial, 'settings put system haptic_feedback_enabled 0')
    adb_shell(serial, 'settings put system notification_vibration_intensity 0 2>/dev/null || true')
    adb_shell(serial, 'settings put system ring_vibration_intensity 0 2>/dev/null || true')
    adb_shell(serial, 'settings put system touch_vibration_intensity 0 2>/dev/null || true')


def ensure_screen_on(serial: str):
    """Wake the phone if its screen is off."""
    try:
        state = adb_shell(serial, 'dumpsys display | grep mScreenState | head -1')
        if 'ON' in (state or ''):
            return
        log.info(f'[{serial}] Screen is off -- sending WAKEUP keyevent')
        adb_shell(serial, 'input keyevent 224')  # KEYCODE_WAKEUP
        import time
        time.sleep(0.5)
    except Exception as e:
        log.warning(f'[{serial}] ensure_screen_on failed: {e}')
