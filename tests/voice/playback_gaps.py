"""Playback gaps: is audio sent on phone-2's control socket played without
holes, and does phone-2's monitor (R = what was played) show it the way the
far end hears it?

phone-2 calls pixel4 and sends a steady 600 Hz tone. Reports:
  - how phone-2's monitor frames arrive (burst size and spacing),
  - exact-zero runs in the monitor's R channel during the tone,
  - level dips in what pixel4 receives during the tone,
  - how long after sending the tone pixel4 hears it (playback buffering,
    Bluetooth, the cellular path and pixel4's capture, together).

  uv run --managed-python --no-project --with websockets --with numpy python tests/voice/playback_gaps.py [--out DIR]
"""
import argparse, asyncio, json, math, ssl, time, wave
import numpy as np
import websockets

import fleet

HOST = fleet.HOST
P2, PX = fleet.host_id("phone-2"), fleet.host_id("phone-pixel4")
T0 = time.time()
log = lambda *a: print(f"+{time.time()-T0:6.1f}s", *a, flush=True)


class Sock:
    def __init__(self, phone, path="control"):
        self.phone, self.path, self.n, self.replies, self.events, self.audio = phone, path, 0, {}, [], []
        self.record = False

    async def open(self):
        q = "?takeover=1" if self.path == "control" else ""
        self.ws = await websockets.connect(f"wss://{HOST}/phones/{self.phone}/ws/voice/{self.path}{q}", ssl=ssl.create_default_context(), max_size=None)
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


def pcm(chunks, t0, t1):
    return np.frombuffer(b"".join(c for t, c in chunks if t0 <= t <= t1), dtype=np.int16)


def zero_runs(x, min_ms=5):
    """Runs of exact zeros at least min_ms long, as (start_ms, length_ms)."""
    z = np.concatenate([[False], x == 0, [False]])
    edges = np.flatnonzero(np.diff(z.astype(np.int8)))
    runs = [(a / 16, (b - a) / 16) for a, b in zip(edges[::2], edges[1::2])]
    return [r for r in runs if r[1] >= min_ms]


def dips(x, win_ms=10, frac=0.25):
    """10 ms windows whose RMS falls below `frac` of the median window."""
    w = 16 * win_ms
    n = len(x) // w
    rms = np.sqrt((x[: n * w].astype(np.float64).reshape(n, w) ** 2).mean(axis=1))
    med = np.median(rms)
    return [i * win_ms for i in np.flatnonzero(rms < frac * med)], med


def onset(chunks, t, level=2000):
    """Seconds from t until a 10 ms window above `level` RMS arrives."""
    for at, c in chunks:
        x = np.frombuffer(c, dtype=np.int16).astype(np.float64)
        if at >= t and len(x) and np.sqrt((x ** 2).mean()) > level:
            return at - t
    return float("nan")


def bursts(chunks):
    """Group frame arrivals into bursts (gap > 8 ms starts a new one)."""
    sizes, starts, cur = [], [], 0
    last = None
    for t, _ in chunks:
        if last is None or t - last > 0.008:
            if cur:
                sizes.append(cur)
            starts.append(t)
            cur = 0
        cur += 1
        last = t
    sizes.append(cur)
    spacing = np.diff(starts) * 1000 if len(starts) > 1 else np.array([0])
    return sizes, spacing


def save(path, x, channels=1):
    with wave.open(path, "wb") as w:
        w.setnchannels(channels)
        w.setsampwidth(2)
        w.setframerate(16000)
        w.writeframes(x.tobytes())


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", help="directory for the wav files")
    args = ap.parse_args()

    s2, sx = await Sock(P2).open(), await Sock(PX).open()
    m2 = await Sock(P2, "monitor").open()
    log("phone-2 hfp", s2.hello["hfp"])
    try:
        await s2.cmd(type="dial", to=fleet.number("phone-pixel4"))
        inc = None
        for _ in range(200):
            inc = next((e["call"]["id"] for e in sx.events if e["type"] == "call.incoming"), None)
            if inc:
                break
            await asyncio.sleep(0.2)
        await asyncio.sleep(2)
        await sx.cmd(type="answer", call=inc)
        await asyncio.sleep(4)
        m2.record = sx.record = True
        await asyncio.sleep(1)
        t = time.time()
        await s2.ws.send(tone(600, 6))
        await asyncio.sleep(7)
        m2.record = sx.record = False
    finally:
        for s in (s2, sx):
            try:
                await asyncio.wait_for(s.cmd(type="hangup"), 15)
            except Exception:
                pass

    sizes, spacing = bursts(m2.audio)
    log(f"monitor frames: {len(m2.audio)} in {len(sizes)} bursts; burst size median {np.median(sizes):.0f} "
        f"(max {max(sizes)}), spacing median {np.median(spacing):.0f} ms")

    # The middle of the tone, clear of its start and end.
    st = pcm(m2.audio, t + 1.0, t + 5.5).reshape(-1, 2)
    right = st[:, 1]
    runs = zero_runs(right)
    log(f"monitor R: {len(runs)} zero runs >= 5 ms in {len(right)/16000:.1f} s: "
        + ", ".join(f"{a:.0f}+{l:.0f}" for a, l in runs[:12]))

    heard = pcm(sx.audio, t + 1.5, t + 6.0)
    d, med = dips(heard)
    log(f"pixel4 hears: {len(d)} dips below 25% in {len(heard)/16000:.1f} s (median rms {med:.0f}): "
        + ", ".join(f"{x}" for x in d[:20]))

    log(f"pixel4 hears the tone {onset(sx.audio, t)*1000:.0f} ms after it was sent")

    if args.out:
        save(f"{args.out}/phone2-monitor.wav", pcm(m2.audio, 0, 1e12), channels=2)
        save(f"{args.out}/pixel4-heard.wav", pcm(sx.audio, 0, 1e12))
        log(f"saved wavs to {args.out}")


asyncio.run(main())
