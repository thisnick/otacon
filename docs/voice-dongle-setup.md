# USB LTE Dongle Setup Guide

Set up a Quectel EG25-G USB LTE dongle on a Raspberry Pi with eSIM provisioning, SMS, and VoLTE support.

## Hardware

- Raspberry Pi (tested on Pi 4/5)
- USB LTE dongle with Quectel EG25-G modem (common in cheap USB LTE sticks)
- 9eSIM card (from [9esim.com](https://www.9esim.com)) — or any nano SIM
- eSIM activation code from a carrier (e.g., Tello, T-Mobile MVNO)

## Prerequisites

### Disable ModemManager on the Pi

**Critical**: ModemManager grabs the modem's serial ports and prevents the container from communicating with it. Disable it:

```bash
sudo systemctl stop ModemManager
sudo systemctl disable ModemManager
```

Without this, all AT commands will return empty responses or the modem will appear unresponsive.

### Verify the dongle is detected

```bash
lsusb | grep Quectel
# Expected: Bus 001 Device XXX: ID 2c7c:0125 Quectel Wireless Solutions Co., Ltd. EC25 LTE modem

ls /dev/ttyUSB*
# Expected: /dev/ttyUSB0 /dev/ttyUSB1 /dev/ttyUSB2 /dev/ttyUSB3
```

The four serial ports serve different functions (varies by dongle):
- Try each port with `AT` command to find which responds
- Common: ttyUSB2 or ttyUSB3 for AT commands

## Docker Container

### Dockerfile

The `otacon-voice` container includes:
- **ModemManager, QMI/MBIM utils** — modem management
- **minicom, picocom** — AT command tools
- **lpac** — eSIM profile management (built from source with AT APDU backend)
- **Python3 + pyserial** — scripting

See `Dockerfile.voice` in the repo.

### docker-compose.yml

```yaml
voice:
  platform: linux/arm64
  build:
    context: .
    dockerfile: Dockerfile.voice
  container_name: otacon-voice
  restart: unless-stopped
  privileged: true
  network_mode: host  # Required for lpac to reach eSIM servers
  devices:
    - /dev/ttyUSB0:/dev/ttyUSB0
    - /dev/ttyUSB1:/dev/ttyUSB1
    - /dev/ttyUSB2:/dev/ttyUSB2
    - /dev/ttyUSB3:/dev/ttyUSB3
    - /dev/cdc-wdm0:/dev/cdc-wdm0
  volumes:
    - /dev/bus/usb:/dev/bus/usb
    - /run/dbus:/run/dbus
```

## Finding the AT Command Port

Each dongle maps functions to different ttyUSB ports. Find the right one:

```python
import serial, time
for port in ['/dev/ttyUSB0', '/dev/ttyUSB1', '/dev/ttyUSB2', '/dev/ttyUSB3']:
    try:
        s = serial.Serial(port, 115200, timeout=2)
        s.write(b'AT\r\n')
        time.sleep(1)
        resp = s.read(1024).decode(errors='replace').strip()
        s.close()
        if resp:
            print(f'{port}: {resp}')
    except Exception as e:
        print(f'{port}: ERROR {e}')
```

Use whichever port responds with `OK`.

## Firmware Update

### Check current firmware

```
AT+QGMR
# Response: EG25GGBR07A08M2G_XX.XXX.XX.XXX
```

### Why update?

The default firmware on many EG25-G dongles does not have IMS/VoLTE enabled. On LTE-only networks (like T-Mobile US, which shut down 3G), SMS and voice calls require VoLTE. Without it, the dongle is data-only.

### Flash stock firmware with VoLTE

Firmware `30.203.30.203` from the [quectel_eg25_recovery](https://github.com/Biktorgj/quectel_eg25_recovery) repo has IMS support:

```bash
# Download firmware
curl -sL https://github.com/Biktorgj/quectel_eg25_recovery/archive/refs/heads/EG25GGBR07A08M2G_30.203.30.203.tar.gz -o fw.tar.gz
tar xzf fw.tar.gz
cd quectel_eg25_recovery-EG25GGBR07A08M2G_30.203.30.203

# Enter fastboot mode (replace ttyUSBX with your AT port)
echo -ne 'AT+QFASTBOOT\r' > /dev/ttyUSB2
sleep 3
fastboot devices  # Should show a device

# Flash all partitions
fastboot flash aboot update/appsboot.mbn
fastboot flash:raw boot update/mdm9607-boot.img
fastboot flash:raw recovery update/mdm9607-boot.img
fastboot flash system update/mdm9607-sysfs.ubi
fastboot flash recoveryfs update/mdm9607-recovery.ubi
fastboot flash modem update/NON-HLOS.ubi
fastboot reboot
```

**Note**: The `sbl1`, `tz`, and `rpm` partitions may fail to flash via fastboot on some dongles. Skip them — the existing ones are compatible.

After reboot, wait ~30 seconds for the modem to initialize. The USB ports may disappear briefly.

### Verify firmware

```
AT+QGMR
# Response: EG25GGBR07A08M2G_30.203.30.203
```

## Enable IMS/VoLTE

**Important**: IMS is disabled by default even on firmware that supports it.

```
AT+QCFG="ims",1
# Response: OK

# Verify
AT+QCFG="ims"
# Response: +QCFG: "ims",1,1
# First 1 = enabled, second 1 = IMS registered
```

**Quoting matters**: The double quotes around `"ims"` are part of the AT command. If using Python/scripts, ensure quotes are not stripped:

```python
# WRONG — quotes get eaten:
at(s, 'AT+QCFG="ims",1')

# RIGHT — use raw bytes or proper escaping:
s.write(b'AT+QCFG="ims",1\r\n')
```

## eSIM Provisioning with lpac

### Get chip info and EID

```bash
LPAC_APDU=at LPAC_APDU_AT_DEVICE=/dev/ttyUSB2 lpac chip info
```

Returns JSON with:
- `eidValue` — the card's EID (needed by some carriers)
- `EuiccConfiguredAddresses` — default SMDP+ server
- `freeNonVolatileMemory` — available space for profiles

### Download an eSIM profile

You need an activation code from your carrier, formatted as:
`LPA:1$<smdp-server>$<activation-code>`

```bash
LPAC_APDU=at LPAC_APDU_AT_DEVICE=/dev/ttyUSB2 \
  lpac profile download -s <smdp-server> -m <activation-code>
```

Example for Tello (T-Mobile MVNO):
```bash
LPAC_APDU=at LPAC_APDU_AT_DEVICE=/dev/ttyUSB2 \
  lpac profile download -s t-mobile.idemia.io -m 9AF6DAA3FAA5B97E57D916AEBD5831C7
```

### Enable the profile

```bash
LPAC_APDU=at LPAC_APDU_AT_DEVICE=/dev/ttyUSB2 \
  lpac profile enable <iccid>
```

### List profiles

```bash
LPAC_APDU=at LPAC_APDU_AT_DEVICE=/dev/ttyUSB2 \
  lpac profile list
```

### After enabling a profile

Reset the radio to register on the network:

```
AT+CFUN=0
# Wait 2 seconds
AT+CFUN=1
# Wait 5-10 seconds

AT+COPS?
# Response: +COPS: 0,0,"Tello",7  (or your carrier name)

AT+CREG?
# Response: +CREG: 0,1  (1 = registered on home network)
```

## SMS

### Send SMS

```
AT+CMGF=1                          # Text mode
AT+CMGS="+1234567890"               # Recipient (wait for > prompt)
Hello from the Pi!<Ctrl+Z>          # Message body + Ctrl+Z to send
# Response: +CMGS: 0  (success)
```

Python example:
```python
import serial, time

s = serial.Serial('/dev/ttyUSB2', 115200, timeout=5)
s.write(b'AT+CMGF=1\r\n')
time.sleep(1)
s.read(1024)  # clear buffer

s.write(b'AT+CMGS="+1234567890"\r\n')
time.sleep(2)
prompt = s.read(1024).decode()
if '>' in prompt:
    s.write(b'Hello from the Pi!\x1a')  # \x1a = Ctrl+Z
    time.sleep(10)
    print(s.read(4096).decode())
s.close()
```

### Receive SMS

Enable notifications:
```
AT+CNMI=2,1,0,0,0    # Notify on new messages
```

Read all messages:
```
AT+CMGF=1
AT+CMGL="ALL"
```

### Get phone number

```
AT+CNUM
# Response: +CNUM: ,"15102901178",129
```

## Troubleshooting

### "SIM not inserted" (CME ERROR: 10)

1. **Check ModemManager**: `ps aux | grep ModemManager` — if running, stop and disable it
2. **Check SIM detect pin**: `AT+QSIMDET?` — some dongles have a hardware SIM detect switch that 9eSIM adapters don't trigger. Try a different dongle.
3. **Check SIM voltage**: `AT+QSIMVOL?` — if 0, the modem isn't powering the SIM slot

### AT commands return empty responses

- ModemManager is likely holding the port. Stop it: `sudo systemctl stop ModemManager`
- Try a different ttyUSB port

### "ERROR" on AT+CMGS (SMS send fails)

- IMS not enabled: `AT+QCFG="ims",1` (with proper double quotes)
- Check network registration: `AT+CREG?` should return `0,1`
- Check IMS registration: `AT+QCFG="ims"` second value should be `1`

### Modem stops responding after AT+CFUN reset

- The modem reboots and USB devices disappear briefly
- Wait 30 seconds, or unplug and replug the dongle
- Restart the Docker container after replug: `docker restart otacon-voice`

### Firmware flash: "update_ubi_vol failed"

- Some partitions (sbl1, tz, rpm) can't be flashed via fastboot on certain dongles
- Skip them — flash only: aboot, boot, recovery, system, recoveryfs, modem

### Quoting issues in AT commands

Double quotes in AT commands like `AT+QCFG="ims"` are part of the protocol. When sending from Python, shell, or other languages, ensure quotes reach the modem:

```python
# Use raw bytes
s.write(b'AT+QCFG="ims",1\r\n')

# Or escape properly in strings
s.write('AT+QCFG="ims",1\r\n'.encode())
```

## Current Status

- **Firmware**: EG25GGBR07A08M2G_30.203.30.203
- **IMS/VoLTE**: Enabled and registered
- **SMS**: Send and receive working
- **Voice calls**: Untested (IMS is registered, should work)
- **Data**: LTE connected, APNs auto-configured
- **eSIM**: Tello (T-Mobile MVNO) profile provisioned via lpac

## References

- [Quectel EG25-G firmware repo](https://github.com/Biktorgj/quectel_eg25_recovery)
- [PinePhone modem SDK](https://github.com/the-modem-distro/pinephone_modem_sdk) (custom firmware, also works on generic EG25-G)
- [lpac eSIM tool](https://github.com/estkme-group/lpac)
- [9eSIM cards](https://www.9esim.com)
- [Quectel forums](https://forums.quectel.com)
