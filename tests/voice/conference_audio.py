"""Does audio flow between the parties of a merged (HFP AT+CHLD=3) call?

phone-2 (host) calls pixel4 and phone-3, merges (optionally swapping first
with --swap); then each phone plays a tone in turn and every other phone's
downlink is measured at that frequency, for 5 rounds.

  uv run --managed-python --no-project --with websockets --with numpy python tests/voice/conference_audio.py [--swap]
"""
import asyncio, json, math, ssl, struct, time
import numpy as np
import websockets

import fleet

HOST = fleet.HOST
P2, PX, P3 = fleet.host_id("phone-2"), fleet.host_id("phone-pixel4"), fleet.host_id("phone-3")
NUM = {PX: fleet.number("phone-pixel4"), P3: fleet.number("phone-3")}
T0 = time.time()
import sys
SWAP = "--swap" in sys.argv
ROUNDS = 5
log = lambda *a: print(f"+{time.time()-T0:6.1f}s", *a, flush=True)


class Sock:
    def __init__(self, phone):
        self.phone, self.n, self.replies, self.events, self.audio = phone, 0, {}, [], []
        self.record = False

    async def open(self):
        self.ws = await websockets.connect(f"wss://{HOST}/phones/{self.phone}/ws/voice/control?takeover=1",
                                           ssl=ssl.create_default_context(), max_size=None)
        self.hello = json.loads(await self.ws.recv())
        self.task = asyncio.create_task(self.read())
        return self

    async def read(self):
        async for m in self.ws:
            if isinstance(m, bytes):
                if self.record:
                    self.audio.append((time.time(), m))
                continue
            msg = json.loads(m)
            if msg["type"] in ("ack", "error") and msg.get("id"):
                self.replies[msg["id"]] = msg
            else:
                self.events.append(msg)

    async def cmd(self, **c):
        self.n += 1
        cid = str(self.n)
        await self.ws.send(json.dumps({**c, "id": cid}))
        while cid not in self.replies:
            await asyncio.sleep(0.05)
        r = self.replies.pop(cid)
        log(self.phone, c["type"], "->", r["type"], r.get("code", ""), r.get("message", ""))
        return r

    async def wait_incoming(self, timeout=40):
        end = time.time() + timeout
        while time.time() < end:
            for e in self.events:
                if e["type"] == "call.incoming":
                    return e["call"]["id"]
            await asyncio.sleep(0.2)


def tone(hz, secs, rate=16000):
    t = np.arange(int(secs * rate)) / rate
    return (8000 * np.sin(2 * math.pi * hz * t)).astype(np.int16).tobytes()


def level(chunks, t0, t1, hz):
    pcm = b"".join(c for t, c in chunks if t0 <= t <= t1)
    x = np.frombuffer(pcm, dtype=np.int16).astype(np.float32)
    if len(x) < 1600:
        return 0.0
    spec = np.abs(np.fft.rfft(x * np.hanning(len(x))))
    freqs = np.fft.rfftfreq(len(x), 1 / 16000)
    band = spec[(freqs > hz - 30) & (freqs < hz + 30)].max()
    noise = np.median(spec) + 1e-9
    return float(band / noise)


async def main():
    s2, sx, s3 = [await Sock(p).open() for p in (P2, PX, P3)]
    try:
        r = await s2.cmd(type="dial", to=NUM[PX])
        cid = await sx.wait_incoming(); await asyncio.sleep(2); await sx.cmd(type="answer", call=cid)
        await asyncio.sleep(3)
        await s2.cmd(type="hold")
        await s2.cmd(type="dial", to=NUM[P3])
        cid = await s3.wait_incoming(); await asyncio.sleep(2); await s3.cmd(type="answer", call=cid)
        await asyncio.sleep(3)
        for s in (s2, sx, s3):
            s.record = True
        # Before merge: pixel4 is held; phone-3 talks to phone-2 only.
        t = time.time(); await s3.ws.send(tone(600, 3)); await asyncio.sleep(3.5)
        log("pre-merge 600 Hz from phone-3: at phone-2 %.0f, at pixel4 %.0f" % (level(s2.audio, t, t + 3.5, 600), level(sx.audio, t, t + 3.5, 600)))
        if SWAP:
            await s2.cmd(type="swap")
            await asyncio.sleep(3)
            t = time.time(); await s2.ws.send(tone(800, 3)); await asyncio.sleep(3.5)
            log("after swap 800 Hz from phone-2: at pixel4 %.0f, at phone-3 %.0f" % (level(sx.audio, t, t + 3.5, 800), level(s3.audio, t, t + 3.5, 800)))
            t = time.time(); await sx.ws.send(tone(1000, 3)); await asyncio.sleep(3.5)
            log("after swap 1 kHz from pixel4: at phone-2 %.0f" % level(s2.audio, t, t + 3.5, 1000))
        await s2.cmd(type="merge")
        await asyncio.sleep(4)
        for rnd in range(ROUNDS):
            t = time.time(); await sx.ws.send(tone(1000, 3)); await asyncio.sleep(3.5)
            a = level(s3.audio, t, t + 3.5, 1000); b = level(s2.audio, t, t + 3.5, 1000)
            t = time.time(); await s3.ws.send(tone(600, 3)); await asyncio.sleep(3.5)
            c = level(sx.audio, t, t + 3.5, 600); d = level(s2.audio, t, t + 3.5, 600)
            t = time.time(); await s2.ws.send(tone(800, 3)); await asyncio.sleep(3.5)
            e = level(sx.audio, t, t + 3.5, 800); f = level(s3.audio, t, t + 3.5, 800)
            log(f"round {rnd}: pixel4->phone3 {a:.0f} pixel4->phone2 {b:.0f} | phone3->pixel4 {c:.0f} phone3->phone2 {d:.0f} | phone2->pixel4 {e:.0f} phone2->phone3 {f:.0f}")
            await asyncio.sleep(3)
        log("audio frames received: phone-2 %d, pixel4 %d, phone-3 %d" % (len(s2.audio), len(sx.audio), len(s3.audio)))
    finally:
        for s in (s2, sx, s3):
            try:
                await asyncio.wait_for(s.cmd(type="hangup"), 15)
            except Exception:
                pass
        await asyncio.sleep(2)


asyncio.run(main())
