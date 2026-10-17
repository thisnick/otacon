# Live voice tests

These place real calls between fleet phones (and a Twilio test number), so they
need the otacon Pi on the tailnet, phones with service, and
`fleet.local.json` at the repo root: copy `fleet.example.json` and fill in the
host, phone ids and numbers. That file is git-ignored; it's the only place real
phone numbers live. API keys come from the environment, or from 1Password via
its `secrets` section.

Run from the repo root with `uv` (`--managed-python`, so it doesn't pick up the repo's devbox `.venv`).

## otacon voice protocol (`docs/voice-ws.md`)

| Script | What it checks |
|---|---|
| `live_protocol.py [A] [B] [C] [D]` | Commands, acks and events end to end: dial/answer/reject/hangup, marks, DTMF, hold/swap/merge with stable call ids, caller ID (kiosk on the Samsung, HFP on the Pixels), `audio.link`, the monitor's stereo stream |
| `conference_audio.py [--swap]` | After a merge, every party hears every other party (tones, 5 rounds) |
| `duplex.py` | phone-2 still hears the other side while it talks (barge-in is possible) |
| `twilio_ivr.py setup\|test` | A Twilio Studio phone menu ("Luigi's Trattoria": 1 location, 2 prices, 3 reservations → hold music → host). `test` presses 1, 2, 3 with `AT+VTS` and checks the branches Twilio took |

```sh
uv run --managed-python --no-project --with websockets python tests/voice/live_protocol.py A B C
uv run --managed-python --no-project --with websockets --with numpy python tests/voice/conference_audio.py --swap
```

## otacon-voice plugin, end to end (`e2e/`)

A throwaway OpenClaw gateway (`gateway.sh`, port 28789, state in
`~/code/otacon-voice-test`) runs the plugin from `src/openclaw-voice` on
phone-2; its agent is asked to make calls. Realtime personas
(`persona.py`) play the other parties on fleet phones.

```sh
tests/voice/e2e/gateway.sh init      # once: config from fleet.local.json
tests/voice/e2e/gateway.sh install   # build + install the plugin, start the gateway
tests/voice/e2e/run.sh ivr           # menu + hold + booking through the Twilio test number
tests/voice/e2e/run.sh handoff       # warm hand-off: business persona + "Nick" persona, merged
tests/voice/e2e/run.sh inbound       # "Nick" calls phone-2; answered, agent consulted
tests/voice/e2e/gateway.sh stop      # release phone-2
```

Each run writes `call.wav` (stereo: left = the other party, right = the voice
model), the call events, the plugin log and the agent's session history.
