#!/usr/bin/env python3
"""Send SMS via modem."""
import serial, time, sys

PORT = sys.argv[1] if len(sys.argv) > 1 else "/dev/ttyUSB2"
NUMBER = sys.argv[2] if len(sys.argv) > 2 else "+16164259884"
MESSAGE = sys.argv[3] if len(sys.argv) > 3 else "Hello from the Pi LTE dongle!"

s = serial.Serial(PORT, 115200, timeout=5)

s.write(b"AT+CMGF=1\r\n")
time.sleep(1)
s.read(1024)

s.write(f'AT+CMGS="{NUMBER}"\r\n'.encode())
time.sleep(2)
prompt = s.read(1024).decode(errors="replace")
print("Prompt:", repr(prompt))

if ">" in prompt:
    s.write(MESSAGE.encode() + b"\x1a")
    time.sleep(10)
    print("Result:", s.read(4096).decode(errors="replace").strip())
else:
    print("No prompt — SMS failed")

s.close()
