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

# Distinguish HFP vs A2DP arecord instances
ARECORD_PROCS=$(ps aux | grep "[a]record" | grep "bluealsa" || true)
if [ -n "$ARECORD_PROCS" ]; then
    echo "$ARECORD_PROCS" | grep -q "PROFILE=sco" && ok "arecord HFP (SCO capture running)" || info "arecord HFP not running"
    echo "$ARECORD_PROCS" | grep -q "PROFILE=a2dp" && ok "arecord A2DP (media capture running)" || info "arecord A2DP not running"
else
    info "arecord not running"
fi
ps aux | grep -E "[a]play"               >/dev/null && ok "aplay (playback)" || info "aplay not running"

RECON_PID=$(pgrep -f "bt-reconnect.py" 2>/dev/null || true)
if [ -n "$RECON_PID" ]; then
    ok   "bt-reconnect daemon running"
else
    fail "bt-reconnect daemon NOT running"
fi

echo
echo "=== BT Connection ==="
CONN=$(bluetoothctl devices 2>/dev/null | head -1 | awk '{print $2}')
if [ -n "$CONN" ]; then
    BT_INFO=$(bluetoothctl info "$CONN" 2>/dev/null)
    echo "$BT_INFO" | grep -E "Name|Connected|Paired|Trusted|ServicesResolved" | sed 's/^/  /'
    UUIDS=$(echo "$BT_INFO" | grep "UUID")
    echo
    echo "=== Profile Check ==="
    echo "$UUIDS" | grep -q "Handsfree Audio Gateway" && ok "Phone is HFP AG (can route call audio to us)" \
                                                      || fail "HFP AG not in UUID list — call audio won't work"
    echo "$UUIDS" | grep -q "Audio Source\|0000110a"  && ok "Phone is A2DP Source (can stream media to us)" \
                                                      || fail "A2DP Source not in UUID list — media audio won't work"
else
    info "No paired devices found"
    UUIDS=""
fi

echo
echo "=== BlueALSA Transports ==="
python3 - <<'PYEOF'
import dbus, sys

PROFILE_NAMES = {
    "hfphf":   "HFP HF",
    "hfpag":   "HFP AG",
    "a2dpsnk": "A2DP Sink",
    "a2dpsrc": "A2DP Source",
}

MODE_LABELS = {
    ("a2dpsnk", "source"): "phone→Pi (media in)",
    ("a2dpsrc", "sink"):   "Pi→phone (media out)",
    ("hfphf",   "source"): "phone mic→Pi",
    ("hfphf",   "sink"):   "Pi audio→phone",
    ("hfpag",   "source"): "Pi mic→phone",
    ("hfpag",   "sink"):   "phone audio→Pi",
}

try:
    bus = dbus.SystemBus()
    mgr = dbus.Interface(
        bus.get_object("org.bluealsa", "/org/bluealsa"),
        "org.freedesktop.DBus.ObjectManager"
    )
    pcms = mgr.GetManagedObjects()
    found = False
    for path, ifaces in pcms.items():
        if "org.bluealsa.PCM1" not in ifaces:
            continue
        p = ifaces["org.bluealsa.PCM1"]
        mode     = str(p.get("Mode", ""))
        codec    = str(p.get("Codec", ""))
        running  = bool(p.get("Running", False))
        channels = int(p.get("Channels", 0))
        rate     = int(p.get("SamplingFrequency", 0))

        # Parse profile from path (e.g. .../hfphf/source)
        parts = path.rstrip("/").split("/")
        profile_key = parts[-2] if len(parts) >= 2 else ""
        profile_label = PROFILE_NAMES.get(profile_key, profile_key)
        direction = MODE_LABELS.get((profile_key, mode), f"{mode}")

        state_str = "\033[32mACTIVE\033[0m" if running else "\033[33mIDLE\033[0m"
        rate_str  = f"{rate}Hz" if rate else "?Hz"
        ch_str    = f"{channels}ch" if channels else "?ch"
        print(f"  [{profile_label}] {direction}")
        print(f"    codec={codec}  {rate_str}  {ch_str}  state={state_str}")
        found = True
    if not found:
        print("  No PCMs found — phone not connected or profiles not negotiated")
except Exception as e:
    import subprocess
    r = subprocess.run(["bluealsa-aplay", "--list-pcms"], capture_output=True, text=True)
    if r.stdout.strip():
        for line in r.stdout.strip().splitlines():
            print(f"  {line}")
    else:
        print(f"  D-Bus error: {e}")
PYEOF

echo
echo "=== SCO / HCI Link State ==="
hciconfig hci0 2>/dev/null | grep -E "hci0|Type|BD Address|UP|RUNNING|SCO" | sed 's/^/  /' || info "hciconfig unavailable"
SCO_COUNT=$(hcitool con 2>/dev/null | grep -c "SCO" || true)
SCO_COUNT=${SCO_COUNT:-0}
if [ "${SCO_COUNT}" -gt 0 ] 2>/dev/null; then
    ok "SCO link OPEN ($SCO_COUNT connection(s)) — call audio active"
    hcitool con 2>/dev/null | grep "SCO" | sed 's/^/    /'
else
    info "No SCO link — call audio inactive (normal when no call in progress)"
fi

echo
echo "=== Audio Levels ==="
python3 - <<'PYEOF'
import subprocess, struct, sys, re, time, os

HFP_RATE   = 16000
A2DP_RATE  = 44100
FRAMES_HFP  = HFP_RATE  // 4   # 0.25s
FRAMES_A2DP = A2DP_RATE // 4

def level_bar(peak, width=32):
    pct = peak / 32767
    filled = int(pct * width)
    bar = "█" * filled + "░" * (width - filled)
    color = "\033[32m" if pct > 0.01 else "\033[33m"
    return f"{color}[{bar}]\033[0m {pct*100:5.1f}%  peak={peak}"

def sample_device(label, dev, rate, channels, frames):
    """Try to read PCM frames; print level bar or status."""
    try:
        proc = subprocess.Popen(
            ["arecord", "-D", dev, "-f", "S16_LE",
             "-r", str(rate), "-c", str(channels), "-t", "raw"],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE
        )
        try:
            raw, err = proc.communicate(timeout=0.6)
        except subprocess.TimeoutExpired:
            proc.kill()
            raw, err = proc.communicate()

        err_str = err.decode(errors="replace")
        err_lines = [l.strip() for l in err_str.strip().splitlines() if l.strip()]

        if len(raw) >= 64:
            samples = struct.unpack(f"{len(raw)//2}h", raw[:len(raw)//2*2])
            peak = max(abs(s) for s in samples)
            print(f"  {label}: {level_bar(peak)}")
        elif any("busy" in l.lower() for l in err_lines):
            print(f"  {label}: \033[32m[device in use by audio server — OK]\033[0m")
        elif any("Closing" in l or "not running" in l.lower() for l in err_lines):
            print(f"  {label}: \033[33m[device not active]\033[0m")
            for l in err_lines[-2:]:
                if "bluealsa-pcm" not in l:
                    print(f"           {l[:100]}")
        else:
            last = err_lines[-1][:100] if err_lines else "no data"
            print(f"  {label}: \033[33m[{last}]\033[0m")
    except Exception as e:
        print(f"  {label}: [error — {e}]")

# Determine device strings from BLUEALSA_DEVICE env or bluealsa-aplay
bluealsa_dev = os.environ.get("BLUEALSA_DEVICE", "")
if not bluealsa_dev:
    r = subprocess.run(["bluealsa-aplay", "--list-pcms"], capture_output=True, text=True)
    for line in r.stdout.splitlines():
        m = re.match(r"\s*(bluealsa:[^\s]+)", line)
        if m:
            bluealsa_dev = m.group(1)
            break

if not bluealsa_dev:
    print("  No BlueALSA devices found — pair and connect first")
    sys.exit(0)

# Ensure SCO device has correct format
if "PROFILE=" not in bluealsa_dev:
    bluealsa_dev = bluealsa_dev.rstrip(",") + ",PROFILE=sco"

a2dp_dev = re.sub(r"PROFILE=sco", "PROFILE=a2dp", bluealsa_dev)
# Remove SRV suffix from a2dp device for cleaner display
a2dp_dev_clean = re.sub(r",SRV=[^,\s]+", "", a2dp_dev)
sco_dev_clean  = re.sub(r",SRV=[^,\s]+", "", bluealsa_dev)

print(f"  HFP device:  {sco_dev_clean}")
print(f"  A2DP device: {a2dp_dev_clean}")
print()

# Check uptime of audio server arecord processes
r2 = subprocess.run(["ps", "-o", "pid,etimes,cmd", "-C", "arecord"], capture_output=True, text=True)
for line in r2.stdout.splitlines():
    parts = line.split()
    if len(parts) < 3: continue
    cmd = " ".join(parts[2:])
    if "bluealsa" not in cmd: continue
    try:
        uptime = int(parts[1])
        profile = "A2DP" if "PROFILE=a2dp" in cmd else "HFP"
        color = "\033[32m" if uptime > 10 else "\033[33m"
        print(f"  {color}[audio server {profile} arecord running {uptime}s]\033[0m")
    except (IndexError, ValueError):
        pass

print()

# HFP capture (phone mic → Pi)
sample_device("HFP  MIC IN  (phone→Pi)", bluealsa_dev, HFP_RATE, 1, FRAMES_HFP)

# A2DP capture (phone media → Pi)
sample_device("A2DP MED IN  (phone→Pi)", a2dp_dev, A2DP_RATE, 2, FRAMES_A2DP)

# HFP playback (Pi → phone earpiece)
dev = re.sub(r"PROFILE=sco", "PROFILE=sco", bluealsa_dev)
try:
    proc = subprocess.Popen(
        ["aplay", "-D", dev, "-f", "S16_LE", "-r", str(HFP_RATE), "-c", "1", "-t", "raw"],
        stdin=subprocess.PIPE, stderr=subprocess.PIPE
    )
    try:
        silence = bytes(FRAMES_HFP * 2)
        _, err = proc.communicate(input=silence, timeout=0.8)
        err_str = err.decode(errors="replace")
        err_lines = [l.strip() for l in err_str.strip().splitlines() if l.strip()]
        if any("busy" in l.lower() for l in err_lines):
            print("  HFP  SPK OUT (Pi→phone): \033[32m[in use — OK]\033[0m")
        elif any("Closing" in l or "not running" in l.lower() for l in err_lines):
            print("  HFP  SPK OUT (Pi→phone): \033[33m[SCO not active]\033[0m")
        else:
            print("  HFP  SPK OUT (Pi→phone): \033[32m[path OK]\033[0m")
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.communicate()
        print("  HFP  SPK OUT (Pi→phone): \033[32m[accepting audio]\033[0m")
except Exception as e:
    print(f"  HFP  SPK OUT (Pi→phone): [error — {e}]")
PYEOF
