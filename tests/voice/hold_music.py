"""Does the realtime voice model talk over hold music if it keeps hearing it?

Streams a hold, in real time, into a realtime session set up as OpenClaw sets
it up (server VAD 500 ms, responses on every turn, interrupt on speech), with
the voice model's tools (wait_on_hold, end_call) and its audio NOT gated:
  "Please hold while I connect you", ~40 s of hold music, a recorded hold
  announcement, ~20 s more music, then "Marco" (a person) speaking.
Prints every turn the API detects, everything the model says, its tool
calls, and the tokens used. Two variants of the hold instruction:
  A. the plugin before 2.5: call wait_on_hold when put on hold
  B. listen through: call wait_on_hold once, then stay silent until a person
     speaks to you
  C. no hold tool: say you'll hold, then stay quiet (the navigator watches
     the hold)
  D. no hold tool, recorded messages named: say "I'll hold" once, then
     nothing until a person talks to you

  uv run --managed-python --no-project --with websockets --with numpy --with miniaudio python tests/voice/hold_music.py [A|B|C|D]

This feeds a clean recording. On a real phone line the music sounds
like speech to the model's turn detection far more often (2026-10-19), so
the plugin now mutes hold music while the navigator listens.
"""
import asyncio, base64, json, sys, time, urllib.request
import miniaudio
import numpy as np
import websockets

import fleet

RATE = 24000
MODEL = "gpt-realtime-2.1"
KEY = fleet.secret("OPENAI_API_KEY")
# Path-style URL: the bucket name has dots, which the virtual-host URL's certificate doesn't cover.
HOLD_MUSIC = "https://s3.amazonaws.com/com.twilio.music.classical/BusyStrings.mp3"

BASE = """You are Nick's assistant, speaking on a live phone call on behalf of Nick.
You placed this call to Luigi's Trattoria.
Your goal for this call: Book a table for 2 people tonight at 7:30 PM under the name Nick.

How to behave:
- Speak naturally and briefly: one or two sentences at a time. Let the other side finish.
- When the goal is done, or clearly can't be done, say a short goodbye and then call end_call."""
HOLD = {
    "A": "- If you're put on hold or hear hold music or a 'please hold' message, call wait_on_hold. You stop hearing the line until someone speaks again; if what you then hear is another recorded message, call wait_on_hold again.",
    "B": "- If you're put on hold, call wait_on_hold once, then stay completely silent and keep listening: don't respond to hold music or recorded hold messages. Speak again only when a person talks to you.",
    # No hold tool at all: the phone-menu navigator watches the hold.
    "C": "- If you're asked to hold, say briefly that you'll hold, then stay quiet. Don't respond to hold music or recorded hold messages; speak again when a person talks to you.",
    "D": "- If someone asks you to hold, say \"Sure, I'll hold.\" once. After that, say nothing until a person talks to you directly: hold music and recorded messages (\"your call is important to us\", \"please stay on the line\") never need a reply.",
}
TOOLS = [
    {"type": "function", "name": "wait_on_hold", "description": "You've been put on hold.", "parameters": {"type": "object", "properties": {}}},
    {"type": "function", "name": "end_call", "description": "Hang up and finish. Call after saying goodbye.",
     "parameters": {"type": "object", "properties": {"summary": {"type": "string"}}, "required": ["summary"]}},
]


def tts(text: str, voice: str) -> np.ndarray:
    req = urllib.request.Request(
        "https://api.openai.com/v1/audio/speech",
        data=json.dumps({"model": "gpt-4o-mini-tts", "voice": voice, "input": text, "response_format": "pcm"}).encode(),
        headers={"Authorization": f"Bearer {KEY}", "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=60) as r:
        return np.frombuffer(r.read(), dtype=np.int16)


def music(seconds: float, offset: float = 0) -> np.ndarray:
    data = urllib.request.urlopen(HOLD_MUSIC, timeout=60).read()
    d = miniaudio.decode(data, output_format=miniaudio.SampleFormat.SIGNED16, nchannels=1, sample_rate=RATE)
    x = np.frombuffer(d.samples, dtype=np.int16)
    a = int(offset * RATE)
    return (x[a : a + int(seconds * RATE)] * 0.6).astype(np.int16)  # phone-ish level


def silence(seconds: float) -> np.ndarray:
    return np.zeros(int(seconds * RATE), dtype=np.int16)


async def run(variant: str, timeline: list[tuple[str, np.ndarray]]):
    print(f"\n== variant {variant}: {HOLD[variant][:80]}...")
    url = f"wss://api.openai.com/v1/realtime?model={MODEL}"
    async with websockets.connect(url, additional_headers={"Authorization": f"Bearer {KEY}"}, max_size=None) as ws:
        await ws.send(json.dumps({"type": "session.update", "session": {
            "type": "realtime", "instructions": BASE + "\n" + HOLD[variant],
            "tools": [t for t in TOOLS if variant not in ("C", "D") or t["name"] != "wait_on_hold"], "output_modalities": ["audio"],
            "audio": {
                "input": {"format": {"type": "audio/pcm", "rate": RATE}, "transcription": {"model": "gpt-4o-mini-transcribe"},
                          "turn_detection": {"type": "server_vad", "threshold": 0.5, "prefix_padding_ms": 300,
                                             "silence_duration_ms": 500, "create_response": True, "interrupt_response": True}},
                "output": {"format": {"type": "audio/pcm", "rate": RATE}, "voice": "marin"},
            }}}))
        t0 = time.time() + 0.5
        marks, at = [], 0.0
        for name, a in timeline:
            marks.append((at, name))
            at += len(a) / RATE
        audio = np.concatenate([a for _, a in timeline])
        where = lambda t: next((n for s, n in reversed(marks) if t >= s), "?")

        async def send():
            chunk = RATE * 20 // 1000
            for i in range(0, len(audio), chunk):
                await ws.send(json.dumps({"type": "input_audio_buffer.append", "audio": base64.b64encode(audio[i : i + chunk].tobytes()).decode()}))
                await asyncio.sleep(max(0, t0 + (i + chunk) / RATE - time.time()))

        sender = asyncio.create_task(send())
        end = t0 + len(audio) / RATE + 10
        usage = {"responses": 0, "input_tokens": 0, "output_tokens": 0, "audio_in": 0, "cached": 0}
        while time.time() < end:
            try:
                ev = json.loads(await asyncio.wait_for(ws.recv(), timeout=max(0.1, end - time.time())))
            except asyncio.TimeoutError:
                break
            t = time.time() - t0
            k = ev.get("type", "")
            tag = f"  {t:5.1f}s [{where(t):>12}]"
            if k == "input_audio_buffer.speech_started":
                print(f"{tag} the API heard a turn start")
            elif k == "conversation.item.input_audio_transcription.completed":
                print(f"{tag} heard: {ev.get('transcript', '')[:70]!r}")
            elif k == "response.output_audio_transcript.done":
                print(f"{tag} MODEL SAID: {ev.get('transcript', '')[:90]!r}")
            elif k == "response.function_call_arguments.done":
                print(f"{tag} MODEL CALLED {ev.get('name')}")
                await ws.send(json.dumps({"type": "conversation.item.create", "item": {
                    "type": "function_call_output", "call_id": ev.get("call_id"), "output": json.dumps({"status": "ok"})}}))
            elif k == "response.done":
                u = ev.get("response", {}).get("usage") or {}
                usage["responses"] += 1
                usage["input_tokens"] += u.get("input_tokens", 0)
                usage["output_tokens"] += u.get("output_tokens", 0)
                usage["audio_in"] += (u.get("input_token_details") or {}).get("audio_tokens", 0)
                usage["cached"] += (u.get("input_token_details") or {}).get("cached_tokens", 0)
            elif k == "error":
                print(f"{tag} ERROR {ev.get('error', {}).get('message')}")
        sender.cancel()
        print(f"  usage: {usage}")


async def main():
    hold_msg = tts("Please hold while I connect you to our host.", "onyx")
    announcement = tts("Thank you for holding. Your call is important to us. Please stay on the line and the next available host will be with you shortly.", "onyx")
    marco = tts("Hi, this is Marco at Luigi's. Sorry about the wait! How many people, and what time would you like?", "echo")
    timeline = [
        ("please hold", hold_msg), ("music", music(40)), ("announcement", announcement),
        ("music", music(20, offset=40)), ("Marco", marco), ("after Marco", silence(6)),
    ]
    print("timeline:", ", ".join(f"{n} {len(a)/RATE:.0f}s" for n, a in timeline))
    for v in sys.argv[1:] or ["A", "B"]:
        await run(v, timeline)


asyncio.run(main())
