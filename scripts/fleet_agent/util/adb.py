import subprocess


def adb(serial: str, *args: str, timeout: int = 10) -> str:
    """Run an ADB command targeting a specific device serial."""
    try:
        result = subprocess.run(
            ['adb', '-s', serial, *args],
            capture_output=True, text=True, timeout=timeout,
        )
        return result.stdout.strip()
    except (subprocess.TimeoutExpired, FileNotFoundError):
        return ''


def adb_shell(serial: str, cmd: str, timeout: int = 10) -> str:
    return adb(serial, 'shell', cmd, timeout=timeout)


def get_connected_serials() -> set[str]:
    """Return set of currently connected ADB device serials."""
    try:
        result = subprocess.run(
            ['adb', 'devices'], capture_output=True, text=True, timeout=5,
        )
        serials = set()
        for line in result.stdout.splitlines():
            if line.endswith('\tdevice'):
                serials.add(line.split('\t')[0])
        return serials
    except (subprocess.TimeoutExpired, FileNotFoundError):
        return set()
