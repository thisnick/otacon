#!/usr/bin/env python3
"""Set IMEI and verify."""
import serial, time, sys

PORT = sys.argv[1] if len(sys.argv) > 1 else "/dev/ttyUSB2"
IMEI = sys.argv[2] if len(sys.argv) > 2 else "357635241380908"

s = serial.Serial(PORT, 115200, timeout=3)

def at_raw(cmd):
    s.write(cmd.encode() + b"\r\n")
    time.sleep(1)
    return s.read(4096).decode(errors="replace").strip()

print("Current IMEI:", at_raw("AT+GSN"))
print("Setting IMEI:", at_raw(f'AT+EGMR=1,7,"{IMEI}"'))
print("New IMEI:", at_raw("AT+GSN"))
s.close()
