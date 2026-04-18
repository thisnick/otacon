"""ADB command helpers with injectable runner for testability.

Production code calls adb()/adb_shell() which use the module-level _runner.
Tests call set_runner(MockRunner()) to intercept all subprocess calls.
"""

import subprocess
from typing import Protocol


class Runner(Protocol):
    """Protocol for running shell commands. Override for testing."""
    def run(self, args: list[str], *, input: str | None = None,
            timeout: int = 10) -> subprocess.CompletedProcess:
        ...


class SubprocessRunner:
    """Default runner — delegates to subprocess.run."""
    def run(self, args: list[str], *, input: str | None = None,
            timeout: int = 10) -> subprocess.CompletedProcess:
        return subprocess.run(
            args, capture_output=True, text=True, timeout=timeout,
            input=input,
        )


_runner: Runner = SubprocessRunner()


def set_runner(runner: Runner):
    """Replace the global runner (for testing)."""
    global _runner
    _runner = runner


def get_runner() -> Runner:
    """Return the current runner."""
    return _runner


def adb(serial: str, *args: str, timeout: int = 10) -> str:
    """Run an ADB command targeting a specific device serial."""
    try:
        result = _runner.run(['adb', '-s', serial, *args], timeout=timeout)
        return result.stdout.strip()
    except (subprocess.TimeoutExpired, FileNotFoundError):
        return ''


def adb_shell(serial: str, cmd: str, timeout: int = 10) -> str:
    return adb(serial, 'shell', cmd, timeout=timeout)


def run_cmd(args: list[str], *, input: str | None = None,
            timeout: int = 10) -> subprocess.CompletedProcess:
    """Run an arbitrary command through the injectable runner.

    Used by bluetoothctl and hciconfig callers so they're also mockable.
    """
    return _runner.run(args, input=input, timeout=timeout)


def get_connected_serials() -> set[str]:
    """Return set of currently connected ADB device serials."""
    try:
        result = _runner.run(['adb', 'devices'], timeout=5)
        serials = set()
        for line in result.stdout.splitlines():
            if line.endswith('\tdevice'):
                serials.add(line.split('\t')[0])
        return serials
    except (subprocess.TimeoutExpired, FileNotFoundError):
        return set()
