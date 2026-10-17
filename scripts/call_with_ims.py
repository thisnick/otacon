#!/usr/bin/env python3
"""Reset radio, enable IMS, try one call."""
import serial, time, sys


def _owner_number():
    """The number to call: from the command line, else fleet.local.json's
    ownerNumber (git-ignored; see fleet.example.json)."""
    import json, pathlib
    local = pathlib.Path(__file__).resolve().parent.parent / "fleet.local.json"
    if local.exists():
        return json.loads(local.read_text()).get("ownerNumber")
    sys.exit("pass the number to call, or set ownerNumber in fleet.local.json")


PORT = sys.argv[1] if len(sys.argv) > 1 else "/dev/ttyUSB2"
NUMBER = sys.argv[2] if len(sys.argv) > 2 else _owner_number()

s = serial.Serial(PORT, 115200, timeout=3)

def at_raw(cmd):
    s.write(cmd.encode() + b"\r\n")
    time.sleep(1)
    return s.read(4096).decode(errors="replace").strip()

# Reset radio
at_raw("AT+CFUN=0")
time.sleep(2)
at_raw("AT+CFUN=1")
time.sleep(10)

# Enable IMS
print("Enable IMS:", at_raw('AT+QCFG="ims",1'))
time.sleep(3)

print("IMEI:", at_raw("AT+GSN"))
print("SIM:", at_raw("AT+CPIN?"))
print("Signal:", at_raw("AT+CSQ"))
print("Network:", at_raw("AT+COPS?"))
print("IMS:", at_raw('AT+QCFG="ims"'))
print("Phone:", at_raw("AT+CNUM"))

at_raw("AT+CMEE=2")

print(f"\nDialing {NUMBER}...")
s.write(f"ATD{NUMBER};\r\n".encode())
for i in range(20):
    time.sleep(1)
    data = s.read(4096).decode(errors="replace").strip()
    if data:
        print(f"[{i+1}s] {data}")
        if "NO CARRIER" in data:
            break

print("CEER:", at_raw("AT+CEER"))
at_raw("ATH")
s.close()
