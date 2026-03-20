#!/bin/bash
# Bluetooth + BlueALSA status snapshot for debugging.
# Runs inside the container.

ok()   { printf "  \033[32m[OK  ]\033[0m %s\n" "$1"; }
fail() { printf "  \033[31m[FAIL]\033[0m %s\n" "$1"; }
info() { printf "  \033[33m[----]\033[0m %s\n" "$1"; }

echo "=== Processes ==="
ps aux | grep -E "[b]luealsa"            >/dev/null && ok "bluealsa"    || fail "bluealsa NOT RUNNING"
ps aux | grep -E "[b]luetoothtd|[b]luetooth[d]" >/dev/null && ok "bluetoothd" || fail "bluetoothd NOT RUNNING"
ps aux | grep -E "[b]luetooth.agent"     >/dev/null && ok "bt-agent"    || fail "bt-agent NOT RUNNING"
ps aux | grep -E "[a]record"             >/dev/null && ok "arecord (audio server capturing)" || info "arecord not running"
ps aux | grep -E "[a]play"               >/dev/null && ok "aplay (audio server playing)"     || info "aplay not running"

echo
echo "=== BT Connection ==="
CONN=$(bluetoothctl devices 2>/dev/null | head -1 | awk '{print $2}')
if [ -n "$CONN" ]; then
    BT_INFO=$(bluetoothctl info "$CONN" 2>/dev/null)
    echo "$BT_INFO" | grep -E "Name|Connected|Paired|Trusted|ServicesResolved" | sed 's/^/  /'
else
    info "No paired devices found"
fi

echo
echo "=== HFP Profile Check ==="
if [ -n "$CONN" ]; then
    UUIDS=$(echo "$BT_INFO" | grep "UUID")
    echo "$UUIDS" | grep -q "Handsfree"    && ok "HFP HF registered (phone sees us as headset)" \
                                           || fail "HFP HF NOT in UUID list — phone won't route audio"
    echo "$UUIDS" | grep -q "0000111e"     && ok "UUID 0x111e (HFP) confirmed" \
                                           || info "UUID 0x111e not listed"
    echo "$UUIDS" | grep -q "0000110b\|Advanced Audio" && info "A2DP sink also present" || true
    echo "  UUIDs from phone:"
    echo "$UUIDS" | sed 's/^/    /'
fi

echo
echo "=== BlueALSA Transports (D-Bus) ==="
python3 - <<'PYEOF'
import dbus, sys

try:
    bus = dbus.SystemBus()
    mgr = dbus.Interface(
        bus.get_object("org.bluealsa", "/org/bluealsa"),
        "org.freedesktop.DBus.ObjectManager"
    )
    pcms = mgr.GetManagedObjects()
    found = False
    for path, ifaces in pcms.items():
        if "org.bluealsa.PCM1" in ifaces:
            p = ifaces["org.bluealsa.PCM1"]
            profile  = str(p.get("Profile", ""))
            mode     = str(p.get("Mode", ""))
            codec    = str(p.get("Codec", ""))
            running  = bool(p.get("Running", False))
            dev      = str(p.get("Device", ""))
            channels = int(p.get("Channels", 0))
            rate     = int(p.get("SamplingFrequency", 0))
            state    = "\033[32mACTIVE\033[0m" if running else "\033[33mIDLE\033[0m"
            print(f"  {path}")
            print(f"    device={dev}  profile={profile}  mode={mode}")
            print(f"    codec={codec}  {rate}Hz  {channels}ch  → {state}")
            found = True
    if not found:
        print("  No PCMs found — phone not connected or HFP not negotiated")
except Exception as e:
    import subprocess
    r = subprocess.run(["bluealsa-aplay", "--list-pcms"], capture_output=True, text=True)
    if r.stdout.strip():
        for line in r.stdout.strip().splitlines():
            print(f"  {line}")
        print("  (detailed state unavailable — install python3-dbus)")
    else:
        print(f"  D-Bus error: {e}")
PYEOF

echo
echo "=== SCO / HCI Link State ==="
# hciconfig shows whether SCO links are open at the HCI level
hciconfig hci0 2>/dev/null | grep -E "hci0|Type|BD Address|UP|RUNNING|SCO" | sed 's/^/  /' || info "hciconfig unavailable"
# Count active SCO connections
SCO_COUNT=$(hcitool con 2>/dev/null | grep -c "SCO" || true)
SCO_COUNT=${SCO_COUNT:-0}
if [ "${SCO_COUNT}" -gt 0 ] 2>/dev/null; then
    ok "SCO link OPEN ($SCO_COUNT connection(s))"
    hcitool con 2>/dev/null | grep "SCO" | sed 's/^/  /'
else
    info "No SCO links open (SCO opens when phone routes audio to headset)"
fi

echo
echo "=== Audio Levels ==="
python3 - <<'PYEOF'
import subprocess, struct, sys, re, time

RATE   = 16000
FRAMES = RATE // 2  # 0.5s of samples

def level_bar(peak, width=32):
    pct = peak / 32767
    filled = int(pct * width)
    bar = "█" * filled + "░" * (width - filled)
    color = "\033[32m" if pct > 0.01 else "\033[33m"
    return f"{color}[{bar}]\033[0m {pct*100:5.1f}%  peak={peak}"

# Find device strings from bluealsa-aplay
r = subprocess.run(["bluealsa-aplay", "--list-pcms"], capture_output=True, text=True)
cap_dev = None
play_dev = None
for line in r.stdout.splitlines():
    line = line.strip()
    m = re.match(r"(bluealsa:[^\s]+)", line)
    if m:
        dev = m.group(1)
        idx = r.stdout.find(line)
        snippet = r.stdout[idx:idx+300]
        if "capture" in snippet and cap_dev is None:
            cap_dev = dev
        elif "playback" in snippet and play_dev is None:
            play_dev = dev

if cap_dev is None and play_dev is None:
    print("  No BlueALSA devices found — pair and connect first")
    sys.exit(0)

print(f"  Capture device:  {cap_dev or '(none)'}")
print(f"  Playback device: {play_dev or '(none)'}")
print()

# Check if audio server's arecord is stably running (not restarting)
# If it's been alive > 10s, SCO is likely active
r2 = subprocess.run(["ps", "-o", "pid,etimes,cmd", "-C", "arecord"], capture_output=True, text=True)
sco_via_server = False
for line in r2.stdout.splitlines():
    if "bluealsa" in line:
        parts = line.split()
        try:
            uptime = int(parts[1])
            if uptime > 10:
                sco_via_server = True
                print(f"  \033[32m[audio server arecord running {uptime}s — SCO active]\033[0m")
        except (IndexError, ValueError):
            pass

# --- Capture (phone mic → Pi) ---
dev = cap_dev or "bluealsa:DEV=00:00:00:00:00:00,PROFILE=sco"
try:
    proc = subprocess.Popen(
        ["arecord", "-D", dev,
         "-f", "S16_LE", "-r", str(RATE), "-c", "1", "-t", "raw"],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE
    )
    try:
        raw, err = proc.communicate(timeout=0.6)
    except subprocess.TimeoutExpired:
        proc.kill()
        raw, err = proc.communicate()

    err_str = err.decode(errors="replace")
    if len(raw) >= 64:
        samples = struct.unpack(f"{len(raw)//2}h", raw[:len(raw)//2*2])
        peak = max(abs(s) for s in samples)
        print(f"  MIC IN  (phone→Pi): {level_bar(peak)}")
    else:
        all_lines = [l.strip() for l in err_str.strip().splitlines() if l.strip()]
        if any("busy" in l.lower() for l in all_lines):
            print("  MIC IN  (phone→Pi): \033[32m[device in use by audio server — SCO active]\033[0m")
        elif any("Closing" in l or "not running" in l.lower() for l in all_lines):
            print("  MIC IN  (phone→Pi): \033[33m[SCO not active — trigger voice call]\033[0m")
        else:
            for l in all_lines[-3:]:
                print(f"  MIC IN  stderr: {l[:100]}")
except Exception as e:
    print(f"  MIC IN  (phone→Pi): [error — {e}]")

# --- Playback (Pi → phone speaker) ---
dev = play_dev or "bluealsa:DEV=00:00:00:00:00:00,PROFILE=sco"
try:
    proc = subprocess.Popen(
        ["aplay", "-D", dev,
         "-f", "S16_LE", "-r", str(RATE), "-c", "1", "-t", "raw"],
        stdin=subprocess.PIPE, stderr=subprocess.PIPE
    )
    try:
        silence = bytes(FRAMES * 2)
        _, err = proc.communicate(input=silence, timeout=0.8)
        err_str = err.decode(errors="replace")
        all_lines = [l.strip() for l in err_str.strip().splitlines() if l.strip()]
        if any("busy" in l.lower() for l in all_lines):
            print("  SPK OUT (Pi→phone): \033[32m[device in use by audio server — path OK]\033[0m")
        elif any("Closing" in l or "not running" in l.lower() for l in all_lines):
            print("  SPK OUT (Pi→phone): \033[33m[SCO not active]\033[0m")
            for l in all_lines[-2:]:
                print(f"  SPK OUT stderr: {l[:100]}")
        else:
            print("  SPK OUT (Pi→phone): \033[32m[path OK]\033[0m")
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.communicate()
        print("  SPK OUT (Pi→phone): \033[32m[path OK — accepting audio]\033[0m")
except Exception as e:
    print(f"  SPK OUT (Pi→phone): [error — {e}]")
PYEOF
