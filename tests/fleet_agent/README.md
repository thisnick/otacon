# fleet_agent test suite

Three test layers for the fleet_agent package.

## Unit tests (`unit/`)

Pure Python, no I/O. Mock all subprocess, filesystem, and network calls.

```bash
cd /path/to/otacon
pytest tests/fleet_agent/unit/ -v
```

## Integration tests (`integration/`)

Test module interactions with mocked subprocess/network via pytest fixtures.
No real devices or network required.

```bash
pytest tests/fleet_agent/integration/ -v
```

## Run all CI tests (unit + integration)

```bash
pytest tests/fleet_agent/ -v --ignore=tests/fleet_agent/hardware
```

## Hardware tests (`hardware/`)

Shell scripts that run against a live Pi with phones attached.
NOT for CI -- requires SSH access to `otacon-pi` and the registry at `localhost:8080`.

### Prerequisites

- SSH access: `ssh nick@otacon-pi` (Tailscale)
- Pi server: `https://otacon-pi:8080` (TLS self-signed)
- Registry: `http://localhost:8080` (running on Mac)
- Container running with fleet-agent deployed
- 3 phones connected (Pixel, S22, third device)
- Tools: `curl`, `jq`, `ssh`

### Run all hardware tests

```bash
./tests/fleet_agent/hardware/run_all.sh
```

### Run individual tests

```bash
./tests/fleet_agent/hardware/test_supervisord.sh        # Tests 1+2
./tests/fleet_agent/hardware/test_phones_discovered.sh   # Test 3
./tests/fleet_agent/hardware/test_monitor_status.sh      # Tests 4+5+6
./tests/fleet_agent/hardware/test_s22_self_heal.sh       # Test 7
./tests/fleet_agent/hardware/test_fleet_cli.sh           # Test 8
./tests/fleet_agent/hardware/test_registry_heartbeats.sh # Test 9
./tests/fleet_agent/hardware/test_no_regressions.sh      # Test 10
./tests/fleet_agent/hardware/test_source_checks.sh       # Test 11
```

### Test 7 (S22 self-heal) notes

This is the headline functional test. It may take up to 2 minutes:
- If S22 is already healthy, the script forces a BT unpair
- Waits 60s for fleet-agent to observe the failure
- Then up to 120s for the maintenance loop to heal
- Records the heal timeline from `monitor.heals`
