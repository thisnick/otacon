"""When does the realtime API transcribe the other side of a call?

Streams ~40 s of non-stop phone-menu speech (OpenAI TTS, pauses trimmed to
150 ms, so the turn detector never sees 500 ms of silence) into:

  A. a realtime session set up as OpenClaw sets it up (server VAD 500 ms,
     input transcription gpt-4o-mini-transcribe), and
  B. a transcription session with no turn detection, committed by us every
     2 s, and
  C. the same, committed at the short pauses between sentences (a quiet
     stretch of 100+ ms after 1.5+ s of speech; at most every 5 s), as the
     plugin's own speech detector could,

and prints when each transcript event arrives, relative to the audio.

  uv run --managed-python --no-project --with websockets --with numpy python tests/voice/transcript_timing.py
"""
import asyncio, base64, json, os, sys, time
import urllib.request
import numpy as np
import websockets

import fleet

RATE = 24000
MODEL = "gpt-realtime-2.1"
STT = "gpt-4o-mini-transcribe"
DELAY = os.environ.get("DELAY", "low")  # gpt-live-transcribe's delay (variant D)
MENU = (
    "Thank you for calling the Metropolitan Museum of Art. For hours and admission, press one. "
    "For directions, parking and our address, press two. For membership, press three. "
    "For group visits and school tours, press four. For the museum shop, press five. "
    "For accessibility services, press six. To hear these options again, press nine. "
)
KEY = fleet.secret("OPENAI_API_KEY")


def tts(text: str) -> np.ndarray:
    req = urllib.request.Request(
        "https://api.openai.com/v1/audio/speech",
        data=json.dumps({"model": "gpt-4o-mini-tts", "voice": "alloy", "input": text, "response_format": "pcm"}).encode(),
        headers={"Authorization": f"Bearer {KEY}", "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=60) as r:
        return np.frombuffer(r.read(), dtype=np.int16)


def trim_pauses(x: np.ndarray, keep_ms=150, win_ms=10, level=300) -> tuple[np.ndarray, float]:
    """Shorten every quiet stretch to keep_ms; returns the audio and its longest pause (ms)."""
    w = RATE * win_ms // 1000
    n = len(x) // w
    quiet = np.sqrt((x[: n * w].astype(np.float64).reshape(n, w) ** 2).mean(axis=1)) < level
    out, run, longest = [], 0, 0
    for i in range(n):
        if quiet[i]:
            run += 1
            if run * win_ms <= keep_ms:
                out.append(x[i * w : (i + 1) * w])
        else:
            longest = max(longest, min(run * win_ms, keep_ms))
            run = 0
            out.append(x[i * w : (i + 1) * w])
    return np.concatenate(out), longest


async def stream(ws, audio: np.ndarray, t0: float, commit_every: float | None, at_pauses=False):
    chunk = RATE * 20 // 1000  # 20 ms
    next_commit = commit_every
    last_commit, quiet_ms = 0.0, 0
    for i in range(0, len(audio), chunk):
        piece = audio[i : i + chunk]
        await ws.send(json.dumps({"type": "input_audio_buffer.append", "audio": base64.b64encode(piece.tobytes()).decode()}))
        at = (i + chunk) / RATE
        if at_pauses:
            quiet_ms = quiet_ms + 20 if np.sqrt((piece.astype(np.float64) ** 2).mean()) < 300 else 0
            if (quiet_ms >= 100 and at - last_commit >= 1.5) or at - last_commit >= 5:
                await ws.send(json.dumps({"type": "input_audio_buffer.commit"}))
                last_commit, quiet_ms = at, 0
        elif commit_every and at >= next_commit:
            await ws.send(json.dumps({"type": "input_audio_buffer.commit"}))
            next_commit += commit_every
        await asyncio.sleep(max(0, t0 + at - time.time()))
    if commit_every or at_pauses:
        await ws.send(json.dumps({"type": "input_audio_buffer.commit"}))


async def run(name: str, url: str, session: dict, audio: np.ndarray, commit_every: float | None, at_pauses=False):
    print(f"\n== {name}")
    async with websockets.connect(url, additional_headers={"Authorization": f"Bearer {KEY}"}, max_size=None) as ws:
        await ws.send(json.dumps({"type": "session.update", "session": session}))
        t0 = time.time() + 0.5
        sender = asyncio.create_task(stream(ws, audio, t0, commit_every, at_pauses))
        end = t0 + len(audio) / RATE + 12
        firsts = {}
        while time.time() < end:
            try:
                ev = json.loads(await asyncio.wait_for(ws.recv(), timeout=max(0.1, end - time.time())))
            except asyncio.TimeoutError:
                break
            t = time.time() - t0
            kind = ev.get("type", "")
            if kind == "error":
                print(f"  {t:6.1f}s ERROR {ev.get('error')}")
            elif kind.startswith("input_audio_buffer.speech") or kind == "input_audio_buffer.committed":
                print(f"  {t:6.1f}s {kind}")
            elif kind == "conversation.item.input_audio_transcription.delta":
                item = ev.get("item_id")
                if item not in firsts:
                    firsts[item] = t
                    print(f"  {t:6.1f}s first text of {item[-6:]}: {ev.get('delta','')[:50]!r}")
            elif kind == "conversation.item.input_audio_transcription.completed":
                print(f"  {t:6.1f}s completed {ev.get('item_id','')[-6:]}: {ev.get('transcript','')[:70]!r}")
        sender.cancel()


async def run_live(name: str, session: dict, audio: np.ndarray):
    """Print the streamed text as it accumulates (every ~2 s), and errors."""
    print(f"\n== {name}")
    async with websockets.connect("wss://api.openai.com/v1/realtime?intent=transcription",
                                  additional_headers={"Authorization": f"Bearer {KEY}"}, max_size=None) as ws:
        await ws.send(json.dumps({"type": "session.update", "session": session}))
        t0 = time.time() + 0.5
        sender = asyncio.create_task(stream(ws, audio, t0, None))
        end = t0 + len(audio) / RATE + 8
        text, shown_at = "", 0.0
        while time.time() < end:
            try:
                ev = json.loads(await asyncio.wait_for(ws.recv(), timeout=max(0.1, end - time.time())))
            except asyncio.TimeoutError:
                break
            t = time.time() - t0
            kind = ev.get("type", "")
            if kind == "error":
                print(f"  {t:6.1f}s ERROR {ev.get('error')}")
            elif kind == "conversation.item.input_audio_transcription.delta":
                text += ev.get("delta", "")
                if t - shown_at >= 2:
                    print(f"  {t:6.1f}s (audio at {min(t, len(audio)/RATE):4.1f}s) ...{text[-90:]!r}")
                    shown_at = t
            elif kind == "conversation.item.input_audio_transcription.completed":
                print(f"  {t:6.1f}s completed: {ev.get('transcript','')[:60]!r}...")
        sender.cancel()
        print(f"  full text: {text!r}")


async def main():
    raw = tts(MENU + MENU)
    audio, longest = trim_pauses(raw)
    print(f"menu audio: {len(audio)/RATE:.1f} s (from {len(raw)/RATE:.1f} s), longest pause {longest} ms")
    fmt = {"type": "audio/pcm", "rate": RATE}
    only = sys.argv[1:]  # e.g. C: run only those variants
    if not only or "A" in only:
      await run(
        "A. realtime session, as OpenClaw sets it up (server VAD, 500 ms silence)",
        f"wss://api.openai.com/v1/realtime?model={MODEL}",
        {"type": "realtime", "output_modalities": ["text"], "audio": {"input": {"format": fmt, "transcription": {"model": STT},
          "turn_detection": {"type": "server_vad", "threshold": 0.5, "prefix_padding_ms": 300, "silence_duration_ms": 500, "create_response": False}}}},
        audio, None,
    )
    if not only or "B" in only:
      await run(
        "B. transcription session, no turn detection, committed every 2 s",
        "wss://api.openai.com/v1/realtime?intent=transcription",
        {"type": "transcription", "audio": {"input": {"format": fmt, "transcription": {"model": STT}, "turn_detection": None}}},
        audio, 2.0,
    )
    if not only or "D" in only:
      await run_live(
        f"D. gpt-live-transcribe, streamed, nothing cut by us (delay {DELAY})",
        {"type": "transcription", "audio": {"input": {"format": fmt,
          "transcription": {"model": "gpt-live-transcribe", "delay": DELAY,
                            "prompt": "An automated phone menu: options are read as 'For <option>, press <number>.'"}}}},
        audio,
      )
    if not only or "C" in only:
      await run(
        "C. transcription session, committed at the short pauses between sentences",
        "wss://api.openai.com/v1/realtime?intent=transcription",
        {"type": "transcription", "audio": {"input": {"format": fmt, "transcription": {"model": STT}, "turn_detection": None}}},
        audio, None, at_pauses=True,
    )


asyncio.run(main())
