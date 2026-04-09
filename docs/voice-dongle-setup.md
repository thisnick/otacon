# USB LTE Dongle Setup Guide

Set up a Quectel EG25-G USB LTE dongle on a Raspberry Pi for voice calls, SMS, and audio recording. Covers firmware, IMS/VoLTE, IMEI spoofing, eSIM provisioning (and why it doesn't work with 9eSIM adapters), and USB audio.

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

### Message storage

Messages are stored in modem memory (ME), not on the SIM card. This means:
- Messages persist across SIM swaps — swapping SIMs won't clear old messages
- Modem memory is finite — periodically delete read messages to avoid filling it

```
AT+CPMS?                    # Check storage usage (e.g., ME: 5/50)
AT+CMGD=1,4                # Delete ALL messages (index 1, flag 4 = all)
AT+CMGD=<index>            # Delete a specific message by index
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

### Voice calls fail with NO CARRIER (CEER: 5,36 or 6,258 or 0,21)

IMS is registered, SMS works, but voice calls get rejected. CEER codes observed:
- `CEER: 0,21` — call rejected
- `CEER: 6,258` — EMM detached / IMS service not available
- `CEER: 5,36` — IMS service unavailable (but call may actually connect — see below)

**What we ruled out (when using 9eSIM):**
- **Not UAC related** — tested with UAC enabled and disabled
- **Not LTE-only mode** — tested `nwscanmode=3`
- **Not codec** — AMR codec config is `15` (all AMR-NB codecs), T-Mobile MBN profile active
- **IMS bearer is up** — CID 2 (ims APN) has IP address and P-CSCF addresses
- **Not just IMEI** — spoofing Samsung IMEI with 9eSIM still blocked, so IMEI alone isn't the issue

**Root cause: 9eSIM EID-based carrier detection**

The 9eSIM adapter card has an EID (eUICC identifier) with a manufacturer prefix (`89044045`, sysmocom) that identifies it as an eSIM-to-SIM converter, not a phone's built-in eSIM. When provisioning through Tello/T-Mobile:

1. The SM-DP+ server sees the 9eSIM's EID during profile download
2. The carrier sees the modem's IMEI (Quectel TAC = modem, not phone) at network registration
3. T-Mobile classifies the line as data-only based on device type, blocking voice and SMS
4. Even with IMEI spoofing, if the line was first activated with a modem IMEI, it stays classified as data-only
5. New lines on the same 9eSIM card get immediately blocked — the EID itself is flagged

**What works: Physical SIM with IMEI spoofing**

Using a regular physical SIM (activated on a real phone) in the dongle with IMEI spoofed to match the phone:
- SMS: working
- Voice calls: working (confirmed — phone rings, audio captured via UAC)
- The modem reports `CEER: 5,36` and `NO CARRIER` after ~5s, but the call actually connects on the remote end (see note below)
- Audio recording via USB Audio Class works

**CEER 5,36 is misleading**: The modem reports the call failed, but it actually connects. The remote phone rings, audio is captured via arecord. This appears to be a modem-side reporting issue, not an actual failure. Do not abort call handling based on this error code.

**Key insight**: The problem was never the modem's VoLTE capability — it was the SIM provisioning pathway. A physical SIM activated on a real phone, then moved to the dongle with a matching spoofed IMEI, bypasses all carrier detection and works for both voice and SMS.

Reference: [PinePhone carrier support](https://wiki.pine64.org/wiki/PinePhone_Carrier_Support) confirms T-Mobile VoLTE works with EG25-G on other MVNOs.

## USB Audio for Voice Calls

USB audio requires **all three** of the following. Missing any one results in silent recordings:

### 1. Enable UAC (USB Audio Class)

```
AT+QCFG="usbcfg",0x2C7C,0x0125,1,1,1,1,1,0,1
AT+CFUN=1,1    # Reboot required
```

Last parameter `1` = UAC enabled. After reboot, the modem exposes an ALSA audio device (check `cat /proc/asound/cards`).

**Note**: Enabling UAC changes USB enumeration — ttyUSB port numbers may shift (but didn't in our testing with firmware 30.203).

### 2. Route audio to USB

```
AT+QAUDMOD=2    # Audio mode: 2 = USB audio (default 0 = built-in codec)
```

### 3. Enable PCM voice over USB

```
AT+QPCMV=1,2    # 1 = enable, 2 = USB
```

Without steps 2 and 3, UAC is on but call audio stays on the (unconnected) built-in codec — recordings will be silent.

### Record a call

```bash
# Install alsa-utils if needed
apt-get install -y alsa-utils

# Record from EG25-G audio device (card 3 in our setup)
arecord -D hw:3,0 -f S16_LE -r 8000 -c 1 -d 30 /tmp/call.wav
```

Recording starts immediately — it will capture ringing/silence before the remote party answers. The modem provides 8kHz mono audio (telephony quality).

## IMEI Spoofing

### Why spoof?

T-Mobile and MVNOs check the IMEI's TAC (Type Allocation Code — first 8 digits) to identify the device type. The EG25-G's native TAC identifies it as a modem module, which can cause the carrier to:
- Block VoLTE/voice calls
- Block SMS ("Message Blocking is active")
- Classify the line as data-only

Spoofing the IMEI to match a VoLTE-capable phone makes the carrier treat the dongle as a phone.

### How to spoof

```
AT+EGMR=1,7,"NEW_IMEI_HERE"    # Write IMEI (slot 1)
AT+GSN                           # Verify new IMEI
AT+CFUN=1,1                     # Reboot to re-register with new IMEI
```

- **Persistent across reboots** — stored in NVRAM
- **Survives firmware updates** — EFS partition usually untouched
- **Does NOT survive full EFS wipe**

### IMEI structure

```
TAC (8 digits) + Serial (6 digits) + Check digit (1 digit, Luhn)
```

- **TAC** (Type Allocation Code) identifies the device model. It's what carriers use for classification.
- US carrier variants share TACs — a T-Mobile Galaxy S22 has the same TAC as a Verizon Galaxy S22. The TAC identifies the phone model, not the carrier.
- The check digit is computed via the Luhn algorithm. Use a valid check digit or some modems/networks may reject it.

### Best practices

1. **Use the IMEI from a phone you own** that is not currently active on any network. Two devices with the same IMEI on the same network can trigger fraud detection.
2. **Dual-SIM phones have two IMEIs** — one per slot. If using a physical SIM in the dongle, use the physical SIM slot's IMEI. If using an eSIM adapter, use the eSIM slot's IMEI.
3. **Spoof BEFORE activating/inserting a new SIM** — the carrier classifies the line based on the IMEI seen at first registration. If the line is already classified as data-only, spoofing after the fact may not help.
4. **Reboot the modem** after changing IMEI so the network sees the new one.

### Samsung Galaxy IMEI slots

On Samsung Galaxy S/Z series dual-SIM phones:
- **IMEI1** = physical SIM slot
- **IMEI2** = eSIM slot
- They have different TACs but from the same manufacturer allocation block
- Dial `*#06#` on the phone to see both IMEIs and the EID
- When spoofing, use the IMEI matching the SIM type: IMEI1 for a physical SIM in the dongle, IMEI2 if you were using an eSIM adapter

### Legal note

IMEI modification is illegal in the US (18 U.S.C. § 1029(a)(10), up to 5 years), UK, India, Australia, and most of the EU. Enforcement against individuals is rare but the legal exposure exists.

## GPS

The EG25-G includes a GPS receiver. NMEA output is on ttyUSB0 (typically). Enable with:

```
AT+QGPS=1
```

Read NMEA sentences from ttyUSB0 or via AT:
```
AT+QGPSGNMEA="GGA"
```

## 9eSIM Adapter Issues

### Carrier blocking

The 9eSIM (eSIM-to-SIM adapter from 9esim.com) has a unique EID prefix (`89044045`, sysmocom manufacturer) that identifies it as an adapter card, not a phone's built-in eSIM. Carriers can detect this.

**What we observed on Tello (T-Mobile MVNO):**
- Lines provisioned via 9eSIM + dongle IMEI → immediately blocked for voice and SMS
- Lines provisioned via 9eSIM + spoofed Samsung IMEI → also blocked
- New Tello accounts with 9eSIM → also blocked
- "Message Blocking is active" on all attempts
- Multiple eSIM profiles tried — all blocked

**Theories:**
1. T-Mobile flags the 9eSIM EID prefix and classifies lines as data-only
2. The first registration with a modem IMEI permanently tags the line
3. Tello account gets flagged after repeated failed attempts

**What works:** A regular physical SIM (activated on a real phone, not the dongle) with IMEI spoofing. This bypasses all the eSIM/EID detection.

### Carrier-specific EID blocking

Some carriers actively block eSIM adapters by EID prefix:
- **NTT DoCoMo (Japan)**: Maintains a whitelist of approved EID prefixes. 9eSIM's prefix is not on it.
- **T-Mobile (US)**: No confirmed automated blocking, but circumstantial evidence suggests filtering

### Managing 9eSIM profiles

Use the **nLPA** app (download from `dl.9esim.com/nLPA.apk`) on an Android phone to manage 9eSIM profiles — download, enable, disable, and delete eSIM profiles directly from the phone.

### If you must use 9eSIM

1. Provision the eSIM profile while the 9eSIM is **in a real phone** (not the dongle) — use nLPA
2. Confirm voice and SMS work on the phone first
3. Then move the 9eSIM to the dongle with IMEI spoofed to match the phone
4. **Untested** — given that T-Mobile appears to flag the EID itself, this may not help. Physical SIM is the proven path.

## Raspberry Pi WiFi Stability

The `brcmfmac` kernel module (Broadcom WiFi driver on Pi) can silently unload, killing the `wlan0` interface and any WiFi AP. This is unrelated to the modem but commonly triggered during USB device enumeration changes (e.g., enabling UAC and rebooting the modem).

A `wifi-monitor.sh` script was added to supervisord to detect when `wlan0` disappears and automatically reload the kernel module:

```bash
# Checks if wlan0 exists, if not: modprobe brcmfmac and restart hostapd
```

Without this, the Pi can lose its WiFi AP with no visible error, requiring a manual reboot.

## Current Status

- **Firmware**: EG25GGBR07A08M2G_30.203.30.203
- **IMS/VoLTE**: Enabled and registered (`+QCFG: "ims",1,1`)
- **T-Mobile MBN**: Commercial-TMO_VoLTE profile active
- **SMS**: Working (with physical SIM + IMEI spoof)
- **Voice calls**: Working (with physical SIM + IMEI spoof) — modem reports CEER 5,36 but call connects
- **USB Audio**: UAC enabled, audio recording confirmed working (`AT+QAUDMOD=2`, `AT+QPCMV=1,2`)
- **Data**: LTE connected, APNs auto-configured (fast.t-mobile.com, ims, sos, tmus)
- **SIM**: Physical Tello SIM (activated on Samsung phone), phone number +15102824086
- **IMEI**: Spoofed to Samsung Galaxy IMEI1 (357111201380908, physical SIM slot)
- **9eSIM**: Not in use — carrier blocks lines provisioned via 9eSIM adapter

## References

- [Quectel EG25-G firmware repo](https://github.com/Biktorgj/quectel_eg25_recovery)
- [PinePhone modem SDK](https://github.com/the-modem-distro/pinephone_modem_sdk) (custom firmware, also works on generic EG25-G)
- [lpac eSIM tool](https://github.com/estkme-group/lpac)
- [9eSIM cards](https://www.9esim.com)
- [Quectel forums](https://forums.quectel.com)
