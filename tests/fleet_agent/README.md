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
- Pi server: `https://otacon-pi.tail0437b8.ts.net:8080` (TLS self-signed)
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

### Phase 3: resilience / auto-reassign tests

These tests verify the 5-min cooldown auto-reassign policy for permanent
phone/dongle loss. They run against the live fleet and involve real
hardware state changes (reboots, adapter power-cycles, container restarts).

```bash
./tests/fleet_agent/hardware/test_transient_phone_disconnect.sh    # Reboot phone, verify same dongle preserved
./tests/fleet_agent/hardware/test_transient_dongle_disconnect.sh   # Power-cycle adapter, verify no reassignment
./tests/fleet_agent/hardware/test_permanent_phone_loss.sh          # Power off phone >5min, verify dongle freed (~6min)
./tests/fleet_agent/hardware/test_permanent_dongle_loss.sh         # Power off dongle >5min, verify phone reassigned (~8min)
./tests/fleet_agent/hardware/test_replug_after_cutoff.sh           # Return lost hardware, verify spare pool (non-reclaiming)
./tests/fleet_agent/hardware/test_host_failure_detection.sh        # Stop/start container, verify host offline/recovery
./tests/fleet_agent/hardware/test_bt_reconnect_after_reboot.sh     # Restart container, verify BT reconnects to same dongles
```

**Timing notes:**
- `test_permanent_phone_loss.sh` and `test_permanent_dongle_loss.sh` each take ~6-8 minutes (5-min cooldown + margin)
- `test_host_failure_detection.sh` stops the container for ~100s
- `test_bt_reconnect_after_reboot.sh` restarts the container
- Run order matters: `test_permanent_dongle_loss.sh` should run before `test_replug_after_cutoff.sh`

**Simulation limitations:**
- Phone disconnect is simulated via `adb reboot` / `adb reboot -p` (not physical unplug)
- Dongle disconnect is simulated via `hciconfig hciN down` (not USB unplug)
- hci0 (built-in BT) is never powered off to avoid breaking the Pi's BT subsystem
