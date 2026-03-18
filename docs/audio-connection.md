# Phone Farm Audio Wiring

## Overview

Each phone connects to the Raspberry Pi via a 3.5mm analog audio path using a crossover wiring scheme. This allows the Pi to **capture caller audio** (what the remote party says) and **inject AI audio** (what the remote party hears) during a live phone call, without requiring root or any special Android permissions.

## Hardware Per Phone

1. **USB sound card** — QimKero TRRS USB sound card (ASIN B0CHYHFRCP, ~$8)
   - USB-A plug goes into Pi
   - Single 3.5mm TRRS female jack (combined mic input + speaker output)
   - Shows up on Linux as a standard `snd-usb-audio` ALSA device
   - Plug and play, no drivers needed

2. **TRRS bare wire cables** — Sovunis 2-pack (ASIN B0CR7WTVWP, ~$6)
   - 3.5mm TRRS male plug on one end, 4 color-coded bare wires on the other
   - Pre-stripped and pre-tinned ends
   - Wire color mapping (CTIA standard):
     - Red   = Pin 1 = Tip    = Left audio channel
     - White = Pin 2 = Ring1  = Right audio channel
     - Green = Pin 3 = Ring2  = Ground
     - Black = Pin 4 = Sleeve = Microphone

3. **2.2kΩ resistor** (~$2)
   - Provides impedance on the phone's mic pin so the phone enters headset mode
   - Without this, the phone detects wrong impedance and falls back to speakers

## Why Crossover Wiring Is Required

Both the phone and the TRRS sound card use the same CTIA pinout. They are both "host" jacks:
- Both output audio on Tip/Ring1 (speaker pins)
- Both expect input on Sleeve (mic pin)

A straight-through TRRS cable would connect speaker-to-speaker and mic-to-mic — neither side would hear the other. The crossover swaps the speaker and mic lines so one host's output feeds the other host's input.

## Crossover Wiring Diagram

```
Cable 1 (plugs into PHONE)          Cable 2 (plugs into SOUND CARD)

  Red   (Left/speaker out) ──twist──→ Black (Mic/input)        CAPTURE: phone audio → Pi
  Black (Mic/input)        ←─twist─── Red   (Left/speaker out) INJECT:  Pi audio → phone
  Green (Ground)           ──twist──→ Green (Ground)            SHARED GROUND
  White (Right)               (tape off, unused)
                                       White (Right)            (tape off, unused)

  On Cable 1 (phone side):
  Black ──┤ 2.2kΩ resistor ├── Green
  (resistor connects mic pin to ground, phone side only)
```

## Signal Flow

```
CAPTURE PATH (what the caller says → Pi receives):
  Phone speaker out → Cable 1 Red → twist → Cable 2 Black → Sound card mic in → Pi ALSA capture

INJECTION PATH (Pi sends AI audio → caller hears):
  Pi ALSA playback → Sound card speaker out → Cable 2 Red → twist → Cable 1 Black → Phone mic in

IMPEDANCE (enables headset mode):
  Cable 1 Black (phone mic) ──┤2.2kΩ├── Cable 1 Green (ground)
  Phone sees ~2.2kΩ on mic pin → enters headset mode → routes audio both directions
```

## Why The Resistor Is Needed

Samsung phones with TRRS jacks actively detect what is plugged in by measuring impedance on the mic pin (sleeve):
- ~0Ω (short to ground) → "TRS headphones, no mic" → headphone-only mode
- ~2.2kΩ → "headset with mic" → full headset mode (audio out + mic in) ✅
- ~16Ω (sound card speaker output impedance) → "unknown device" → rejects, falls back to speakers ❌
- Open circuit → "nothing connected" → falls back to speakers ❌

The 2.2kΩ resistor is wired in parallel on the phone's mic line. It does not block the audio signal from the sound card — it simply provides a DC load that the phone's detection circuit expects. The actual audio passes through on the same wire.

## Physical Assembly

1. Take Cable 1 and Cable 2 (both from the Sovunis 2-pack)
2. On Cable 1 (phone side), twist the 2.2kΩ resistor leads onto the Black and Green bare wires
3. Twist Cable 1 Red to Cable 2 Black (capture path)
4. Twist Cable 1 Black to Cable 2 Red (injection path)
5. Twist Cable 1 Green to Cable 2 Green (ground)
6. Tape off both White wires (unused right channel)
7. Wrap each twist joint with electrical tape
8. Plug Cable 1 male end into the phone's 3.5mm jack
9. Plug Cable 2 male end into the QimKero sound card's TRRS jack
10. Plug the QimKero USB-A into the Raspberry Pi

## Pi Audio Device Identification

Each USB sound card enumerates as an ALSA device. With multiple phones, use udev rules for persistent naming by USB port path:

```
# /etc/udev/rules.d/51-sound-cards.rules
SUBSYSTEM=="sound", ATTR{idVendor}=="0d8c", ENV{ID_PATH}=="*1.1*", ATTR{id}="phone1"
SUBSYSTEM=="sound", ATTR{idVendor}=="0d8c", ENV{ID_PATH}=="*1.2*", ATTR{id}="phone2"
```

Note: Verify the idVendor for the QimKero card with `lsusb` after plugging it in. It may differ from the Sabrent's 0d8c.

## ALSA Usage

Capture caller audio (phone speaker → Pi):
```bash
arecord -D hw:phone1 -f S16_LE -r 16000 -c 1 caller.wav
```

Inject AI audio (Pi → phone mic):
```bash
aplay -D hw:phone1 -f S16_LE -r 16000 -c 1 response.wav
```

## Full Physical Topology

```
[Phone 3.5mm jack]
       |
  Sovunis TRRS cable 1 (male plug)
       |
  [4 bare wires: Red, White, Green, Black]
       |
  [Crossover splice + 2.2kΩ resistor on Black↔Green]
       |
  [4 bare wires: Red, White, Green, Black]
       |
  Sovunis TRRS cable 2 (male plug)
       |
[QimKero TRRS sound card jack]
       |
  [USB-A]
       |
[Raspberry Pi USB port]
```

## Parts List Per Phone

| Item | ASIN | Price |
|------|------|-------|
| QimKero TRRS USB sound card (2-pack) | B0CHYHFRCP | ~$8 |
| Sovunis TRRS bare wire cables (2-pack) | B0CR7WTVWP | ~$6 |
| 2.2kΩ resistor | any assortment kit | ~$2 |
| Electrical tape | — | ~$2 |
| **Total per phone** | | **~$18** |

## Troubleshooting

- **Phone plays through speakers, not cable**: Resistor missing or wrong value. Phone not entering headset mode. Verify resistor is between Cable 1 Black and Green.
- **No audio captured on Pi**: Check crossover — Cable 1 Red must connect to Cable 2 Black. Verify with `arecord` and play audio on phone.
- **No audio injected to phone**: Check crossover — Cable 2 Red must connect to Cable 1 Black. Verify with `aplay` and listen on phone call.
- **Crackling or intermittent audio**: Loose twist connections. Re-twist and tape more securely, or solder the joints.
- **Sound card not detected**: Run `lsusb` to check USB enumeration. Run `arecord -l` to list ALSA capture devices.
