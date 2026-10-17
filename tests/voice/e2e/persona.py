#!/usr/bin/env python3
"""A realtime "person" on a fleet phone, for end-to-end tests: waits for the
phone to ring, answers over ws/voice/control, and lets an OpenAI realtime
model talk on the call. Logs what it heard and said. Exits when the call ends.

  uv run tests/voice/e2e/persona.py --phone phone-pixel4 --persona dental --log run/personas.jsonl

Phones, numbers and the OpenAI key come from fleet.local.json (see ../fleet.py).
"""
# /// script
# dependencies = ["websockets", "numpy"]
# ///
import argparse, asyncio, base64, json, os, re, ssl, time

import pathlib
import sys

import numpy as np
import websockets

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))
import fleet  # noqa: E402

HOST = fleet.HOST
PHONE_SR, MODEL_SR = 16000, 24000

PERSONAS = {
    "dental": (
        "You work the front desk at Bright Smile Dental and you're answering the phone. "
        "Keep every reply to one or two short sentences. Answer with: 'Bright Smile Dental, how can I help you?' "
        "Nick has a teeth cleaning booked Monday at 10 AM. Thursday at 2 PM is open. "
        "Office policy: you only change an appointment after speaking with the patient himself. If the caller is an "
        "assistant or calls on someone's behalf, explain the policy politely and say you'd need Nick on the line. "
        "If asked to hold, say 'Sure, I'll hold' and then stay silent; answer any update while holding with just 'Sure'. "
        "When someone says Nick is joining, wait for him. Only after you hear 'this is Nick', greet him, move the "
        "cleaning to Thursday at 2 PM, confirm it, and say goodbye."
    ),
    "nick-calls": (
        "You are Nick, calling your own phone, which your AI assistant answers. Wait for it to greet you. Then ask: "
        "'Can you check whether I have anything on my calendar tomorrow?' Listen to the answer, react briefly, thank it, "
        "and say goodbye. Keep it short and natural."
    ),
    "nick": (
        "You are Nick. You just answered your phone. Say 'Hello?' once, then listen. Your assistant may ask you to "
        "join a call with your dentist's office: agree, saying something like 'Sure, put me through.' "
        "When you then hear the dental office, say 'Hi, this is Nick, I'd like to move my cleaning to Thursday at "
        "2 PM.' Keep replies short and natural, and say goodbye when they confirm."
    ),
}


def resample(pcm: bytes, src: int, dst: int) -> bytes:
    x = np.frombuffer(pcm, dtype=np.int16).astype(np.float32)
    if len(x) == 0:
        return b""
    n = int(round(len(x) * dst / src))
    y = np.interp(np.linspace(0, len(x) - 1, n), np.arange(len(x)), x)
    return np.clip(y, -32768, 32767).astype(np.int16).tobytes()


class Log:
    def __init__(self, path, tag):
        self.path, self.tag = path, tag

    def __call__(self, kind, text="", **extra):
        with open(self.path, "a") as f:
            f.write(json.dumps({"t": round(time.time(), 2), "who": self.tag, "kind": kind, "text": text, **extra}) + "\n")
        print(f"[{self.tag}] {kind}: {text}", flush=True)


async def run(a):
    log = Log(a.log, a.persona)
    ctx = ssl.create_default_context()
    host_id = fleet.host_id(a.phone)
    phone = await websockets.connect(f"wss://{HOST}/phones/{host_id}/ws/voice/control?takeover=1", ssl=ctx, max_size=None)
    hello = json.loads(await phone.recv())
    n = 0
    replies = {}

    async def cmd(**c):
        nonlocal n
        n += 1
        cid = f"p{n}"
        await phone.send(json.dumps({**c, "id": cid}))
        for _ in range(600):
            if cid in replies:
                return replies.pop(cid)
            await asyncio.sleep(0.05)
        return {"type": "error", "code": "no_reply"}

    events = asyncio.Queue()
    model_q = asyncio.Queue()

    async def read_phone():
        async for m in phone:
            if isinstance(m, bytes):
                await model_q.put(m)
                continue
            msg = json.loads(m)
            if msg["type"] in ("ack", "error") and msg.get("id"):
                replies[msg["id"]] = msg
            else:
                await events.put(msg)

    reader = asyncio.create_task(read_phone())
    call_id = None
    if a.dial:
        to = fleet.number(a.dial) if a.dial in fleet.F["phones"] else a.dial
        r = await cmd(type="dial", to=to)
        call_id = r.get("result", {}).get("call", {}).get("id")
        log("dialing", a.dial)
        deadline = time.time() + 60
        while True:
            try:
                msg = await asyncio.wait_for(events.get(), max(1, deadline - time.time()))
            except asyncio.TimeoutError:
                log("gave-up", "not answered"); await cmd(type="hangup"); return
            if msg.get("call", {}).get("id") == call_id:
                if msg["type"] == "call.ended":
                    log("gave-up", "call ended before answer"); return
                if msg["call"]["state"] == "active":
                    break
    else:
        log("waiting", f"for a call on {a.phone}")
        call_id = next((c["id"] for c in hello["calls"] if c["state"] == "incoming"), None)
    deadline = time.time() + a.ring_timeout
    while not call_id:
        try:
            msg = await asyncio.wait_for(events.get(), max(1, deadline - time.time()))
        except asyncio.TimeoutError:
            log("gave-up", "no incoming call")
            return
        if msg["type"] == "call.incoming":
            call_id = msg["call"]["id"]
    if not a.dial:
        await asyncio.sleep(a.answer_delay)
        r = await cmd(type="answer", call=call_id)
        log("answered", json.dumps(r.get("result", r))[:200])
    while not model_q.empty():
        model_q.get_nowait()

    model = await websockets.connect(
        f"wss://api.openai.com/v1/realtime?model={a.model}",
        additional_headers={"Authorization": f"Bearer {fleet.secret('OPENAI_API_KEY')}"}, max_size=None)
    await model.send(json.dumps({"type": "session.update", "session": {
        "type": "realtime", "instructions": PERSONAS[a.persona], "output_modalities": ["audio"],
        "audio": {
            "input": {"format": {"type": "audio/pcm", "rate": MODEL_SR},
                      "transcription": {"model": "gpt-4o-transcribe"},
                      "turn_detection": {"type": "server_vad", "silence_duration_ms": 600}},
            "output": {"format": {"type": "audio/pcm", "rate": MODEL_SR}, "voice": a.voice}}}}))
    if not a.dial:
        await model.send(json.dumps({"type": "response.create"}))  # answer the phone

    done = asyncio.Event()
    armed = {"goodbye": not a.arm_goodbye_on}

    async def hang_up(why):
        if not done.is_set():
            await cmd(type="hangup")
            log("hung-up", why)
            done.set()

    rx = {"sum": 0.0, "n": 0, "at": time.time()}

    async def phone_to_model():
        while not done.is_set():
            pcm = await model_q.get()
            x = np.frombuffer(pcm, dtype=np.int16).astype(np.float32)
            rx["sum"] += float((x * x).sum()); rx["n"] += len(x)
            if time.time() - rx["at"] >= 2:
                log("rx-level", f"{(rx['sum'] / max(1, rx['n'])) ** 0.5:.0f}")
                rx.update(sum=0.0, n=0, at=time.time())
            await model.send(json.dumps({"type": "input_audio_buffer.append",
                                         "audio": base64.b64encode(resample(pcm, PHONE_SR, MODEL_SR)).decode()}))

    async def model_to_phone():
        async for raw in model:
            ev = json.loads(raw)
            t = ev.get("type", "")
            if t in ("response.output_audio.delta", "response.audio.delta"):
                await phone.send(resample(base64.b64decode(ev["delta"]), MODEL_SR, PHONE_SR))
            elif t == "input_audio_buffer.speech_started":
                await phone.send(json.dumps({"type": "clear", "id": f"c{time.time()}"}))
            elif t == "conversation.item.input_audio_transcription.completed":
                heard = ev.get("transcript", "").strip()
                log("heard", heard)
                if a.arm_goodbye_on and re.search(a.arm_goodbye_on, heard, re.I):
                    armed["goodbye"] = True
            elif t in ("response.output_audio_transcript.done", "response.audio_transcript.done"):
                said = ev.get("transcript", "").strip()
                log("said", said)
                if a.hangup_on_goodbye and armed["goodbye"] and re.search(r"\bgood ?bye\b|\bbye\b", said, re.I):
                    asyncio.get_running_loop().call_later(4, lambda: asyncio.ensure_future(hang_up("after goodbye")))
            elif t == "error":
                log("model-error", json.dumps(ev.get("error", {}))[:300])

    async def watch():
        started = time.time()
        while not done.is_set():
            try:
                msg = await asyncio.wait_for(events.get(), 1)
            except asyncio.TimeoutError:
                if time.time() - started > a.max_seconds:
                    await hang_up("max call length")
                continue
            if msg["type"] == "call.ended" and msg["call"]["id"] == call_id:
                log("call-ended", msg.get("reason", ""))
                done.set()
            elif msg["type"] == "call.state" and msg["call"]["id"] == call_id:
                log("call-state", msg["call"]["state"] + (" conference" if msg["call"]["conference"] else ""))

    tasks = [asyncio.create_task(x()) for x in (phone_to_model, model_to_phone, watch)]
    await done.wait()
    for t in tasks + [reader]:
        t.cancel()
    await model.close()
    await phone.close()


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--phone", required=True, help="fleet phone name in fleet.local.json, e.g. phone-3")
    p.add_argument("--persona", choices=PERSONAS, required=True)
    p.add_argument("--voice", default="cedar")
    p.add_argument("--model", default="gpt-realtime-2.1")
    p.add_argument("--log", required=True)
    p.add_argument("--ring-timeout", type=int, default=240)
    p.add_argument("--answer-delay", type=float, default=2.0)
    p.add_argument("--max-seconds", type=int, default=420)
    p.add_argument("--hangup-on-goodbye", action="store_true")
    p.add_argument("--dial", help="place a call (to a fleet phone name or a number) instead of waiting for one")
    p.add_argument("--arm-goodbye-on", default="", help="regex: only hang up after hearing this")
    asyncio.run(run(p.parse_args()))
