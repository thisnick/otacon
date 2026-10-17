"""Full duplex check: while phone-2 sends a 800 Hz tone, does it still hear
pixel4's 1 kHz tone? (Checks that nothing mutes the downlink while we talk,
which would make barge-in impossible. Measured 2026-10-17: full duplex.)

  uv run --managed-python --no-project --with websockets --with numpy python tests/voice/duplex.py
"""
import asyncio, json, math, ssl, time
import numpy as np
import websockets

import fleet

HOST = fleet.HOST
P2, PX = fleet.host_id("phone-2"), fleet.host_id("phone-pixel4")
T0 = time.time()
log = lambda *a: print(f"+{time.time()-T0:6.1f}s", *a, flush=True)


class Sock:
    def __init__(self, phone):
        self.phone, self.n, self.replies, self.events, self.audio, self.record = phone, 0, {}, [], [], False

    async def open(self):
        self.ws = await websockets.connect(f"wss://{HOST}/phones/{self.phone}/ws/voice/control?takeover=1", ssl=ssl.create_default_context(), max_size=None)
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
        return self.replies.pop(cid)


def tone(hz, secs):
    t = np.arange(int(secs * 16000)) / 16000
    return (8000 * np.sin(2 * math.pi * hz * t)).astype(np.int16).tobytes()


def level(chunks, t0, t1, hz):
    x = np.frombuffer(b"".join(c for t, c in chunks if t0 <= t <= t1), dtype=np.int16).astype(np.float32)
    if len(x) < 1600:
        return 0.0, 0.0
    spec = np.abs(np.fft.rfft(x * np.hanning(len(x))))
    f = np.fft.rfftfreq(len(x), 1 / 16000)
    zeros = float((x == 0).mean())
    return float(spec[(f > hz - 30) & (f < hz + 30)].max() / (np.median(spec) + 1e-9)), zeros


async def main():
    s2, sx = await Sock(P2).open(), await Sock(PX).open()
    log("phone-2 hfp", s2.hello["hfp"])
    try:
        await s2.cmd(type="dial", to=fleet.number("phone-pixel4"))
        for _ in range(200):
            inc = next((e["call"]["id"] for e in sx.events if e["type"] == "call.incoming"), None)
            if inc:
                break
            await asyncio.sleep(0.2)
        await asyncio.sleep(2)
        await sx.cmd(type="answer", call=inc)
        await asyncio.sleep(4)
        s2.record = True
        t = time.time(); await sx.ws.send(tone(1000, 4)); await asyncio.sleep(4.5)
        alone, z1 = level(s2.audio, t + 0.5, t + 4, 1000)
        t = time.time(); await sx.ws.send(tone(1000, 4)); await s2.ws.send(tone(800, 4)); await asyncio.sleep(4.5)
        double, z2 = level(s2.audio, t + 0.5, t + 4, 1000)
        log(f"phone-2 hears pixel4 1 kHz: alone {alone:.0f} (zeros {z1:.2f}); while phone-2 sends {double:.0f} (zeros {z2:.2f})")
    finally:
        for s in (s2, sx):
            try:
                await asyncio.wait_for(s.cmd(type="hangup"), 15)
            except Exception:
                pass


asyncio.run(main())
