#!/usr/bin/env python3
"""Test voice call: dial, play tone, record incoming audio."""
import serial, time, subprocess, os, struct, math, sys

PORT = sys.argv[1] if len(sys.argv) > 1 else "/dev/ttyUSB6"
AUDIO_DEV = sys.argv[2] if len(sys.argv) > 2 else "hw:4"
NUMBER = sys.argv[3] if len(sys.argv) > 3 else "+16164259884"

s = serial.Serial(PORT, 115200, timeout=3)

def at_raw(cmd):
    s.write(cmd.encode() + b"\r\n")
    time.sleep(1)
    return s.read(4096).decode(errors="replace").strip()

print("SIM:", at_raw("AT+CPIN?"))
print("Network:", at_raw("AT+COPS?"))
print("IMS:", at_raw('AT+QCFG="ims"'))
print("CMEE:", at_raw("AT+CMEE=2"))

# Dial
print(f"Dialing {NUMBER}...")
result = at_raw(f"ATD{NUMBER};")
print("ATD:", result)

if "ERROR" in result:
    print("Call failed!")
    s.close()
    sys.exit(1)

print("Waiting 8s for pickup...")
time.sleep(8)
print("Call state:", at_raw("AT+CLCC"))

# Record 10s
print("Recording 10s of your voice...")
rec = subprocess.Popen(
    ["arecord", "-D", AUDIO_DEV, "-f", "S16_LE", "-r", "8000", "-c", "1", "-d", "10", "/tmp/call_in.wav"],
    stderr=subprocess.PIPE
)

# Generate and play 440Hz tone (2 seconds)
print("Playing 440Hz tone for 2s...")
with open("/tmp/tone.raw", "wb") as f:
    for i in range(16000):
        f.write(struct.pack("<h", int(16000 * math.sin(2 * 3.14159 * 440 * i / 8000))))

subprocess.run(
    ["aplay", "-D", AUDIO_DEV, "-f", "S16_LE", "-r", "8000", "-c", "1", "/tmp/tone.raw"],
    stderr=subprocess.PIPE
)

rec.wait()
sz = os.path.getsize("/tmp/call_in.wav") if os.path.exists("/tmp/call_in.wav") else 0
print(f"Recorded: {sz} bytes")

print("Hanging up:", at_raw("ATH"))
s.close()
print("Done!")
