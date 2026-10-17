"""Live test of ws/voice/* and REST calls/* (docs/voice-ws.md) on fleet phones.

phone-2 (Samsung) is the host; phone-pixel4 and phone-3 are the other parties.
Numbers and host ids come from fleet.local.json (see fleet.py).

  uv run --managed-python --no-project --with websockets python tests/voice/live_protocol.py [A] [B] [C] [D]

A: phone-2 dials pixel4, mark, DTMF, hold, dials phone-3, swap, merge, hang up
B: pixel4 calls phone-2 (caller ID from the kiosk on the Samsung), answer, remote hang-up
C: phone-2 calls phone-3 (caller ID over HFP on the Pixel), phone-3 rejects
D: pixel4 dials phone-3, audio + mark, DTMF, hold, resume, hang up
"""
import asyncio
import json
import math
import ssl
import struct
import sys
import time
import urllib.request

import websockets

import fleet

HOST = fleet.HOST
P2, PX, P3 = fleet.host_id("phone-2"), fleet.host_id("phone-pixel4"), fleet.host_id("phone-3")
NUM = {P2: fleet.number("phone-2"), PX: fleet.number("phone-pixel4"), P3: fleet.number("phone-3")}
NAME = {P2: "phone-2", PX: "pixel4", P3: "phone-3"}
T0 = time.time()
RESULTS = []


def log(*a):
    print(f"+{time.time() - T0:7.2f}s", *a, flush=True)


def check(cond, what):
    RESULTS.append((bool(cond), what))
    log(("PASS " if cond else "FAIL ") + what)
    return cond


def rest(phone, method, path, body=None, timeout=40):
    url = f"https://{HOST}/phones/{phone}/api/calls/{path}"
    data = json.dumps(body).encode() if body is not None else (b"{}" if method == "POST" else None)
    req = urllib.request.Request(url, data=data, method=method, headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}")


async def arest(*a, **k):
    return await asyncio.to_thread(rest, *a, **k)


class Sock:
    """A voice socket that records events and resolves command replies."""

    def __init__(self, phone, kind):
        self.phone, self.kind = phone, kind
        self.events = []
        self.pending = {}
        self.audio_bytes = 0
        self.next = 0
        self.waiters = []

    async def open(self, query=""):
        self.ws = await websockets.connect(f"wss://{HOST}/phones/{self.phone}/ws/voice/{self.kind}{query}",
                                           ssl=ssl.create_default_context(), max_size=None)
        self.hello = json.loads(await self.ws.recv())
        self.task = asyncio.create_task(self.reader())
        return self

    async def reader(self):
        try:
            async for m in self.ws:
                if isinstance(m, bytes):
                    self.audio_bytes += len(m)
                    continue
                msg = json.loads(m)
                msg["_t"] = time.time()
                if msg["type"] in ("ack", "error") and msg.get("id") in self.pending:
                    self.pending.pop(msg["id"]).set_result(msg)
                    continue
                self.events.append(msg)
                if msg["type"] != "mark":
                    c = msg.get("call", {})
                    log(f"  [{NAME[self.phone]}/{self.kind}] {msg['type']} {c.get('id', '')} "
                        f"{c.get('state', '')} {c.get('number', '')} {msg.get('reason', '')} conf={c.get('conference', '')} "
                        f"{'' if 'up' not in msg else 'up=' + str(msg['up'])} pos={msg.get('audioPos')}")
                for w in list(self.waiters):
                    if not w[1].done() and w[0](msg):
                        self.waiters.remove(w)
                        w[1].set_result(msg)
        except websockets.exceptions.ConnectionClosed as e:
            log(f"  [{NAME[self.phone]}/{self.kind}] closed {e.rcvd.code if e.rcvd else None}")

    async def cmd(self, **c):
        self.next += 1
        cid = str(self.next)
        fut = asyncio.get_event_loop().create_future()
        self.pending[cid] = fut
        t = time.time()
        await self.ws.send(json.dumps({**c, "id": cid}))
        r = await asyncio.wait_for(fut, 40)
        log(f"  [{NAME[self.phone]}] {c['type']} -> {r['type']} {r.get('code', '')} {r.get('message', '')} "
            f"({(time.time() - t) * 1000:.0f} ms)")
        return r

    async def wait(self, pred, timeout=30, past=True):
        if past:
            for m in self.events:
                if pred(m):
                    return m
        fut = asyncio.get_event_loop().create_future()
        w = (pred, fut)
        self.waiters.append(w)
        try:
            return await asyncio.wait_for(fut, timeout)
        except asyncio.TimeoutError:
            return None
        finally:
            if w in self.waiters:
                self.waiters.remove(w)

    async def close(self):
        await self.ws.close()
        self.task.cancel()


def ev(ty, **kw):
    def pred(m):
        if m["type"] != ty:
            return False
        c = m.get("call", {})
        return all((c.get(k) if k in c else m.get(k)) == v for k, v in kw.items())
    return pred


def tone(secs, hz=440, rate=16000):
    n = int(secs * rate)
    return b"".join(struct.pack("<h", int(8000 * math.sin(2 * math.pi * hz * i / rate))) for i in range(n))


async def answer_on(phone, timeout=45):
    """Wait until `phone` rings, then answer it through otacon."""
    end = time.time() + timeout
    while time.time() < end:
        st, body = await arest(phone, "GET", "status")
        if st == 200 and any(c["state"] == "incoming" for c in body["calls"]):
            st, body = await arest(phone, "POST", "answer")
            log(f"  [{NAME[phone]}] REST answer -> {st} {body.get('error', '')} {body.get('message', '')}")
            return st == 200
        await asyncio.sleep(0.5)
    log(f"  [{NAME[phone]}] never rang")
    return False


async def idle(phone, timeout=10):
    end = time.time() + timeout
    while time.time() < end:
        st, body = await arest(phone, "GET", "status")
        if st == 200 and not body["calls"]:
            return True
        await asyncio.sleep(0.5)
    return False


async def cleanup():
    for p in (P2, PX, P3):
        for _ in range(3):
            st, body = await arest(p, "GET", "status")
            if st != 200 or not body["calls"]:
                break
            await arest(p, "POST", "hangup")
            await asyncio.sleep(1)


async def scenario_a():
    log("=== A: phone-2 dials pixel4, DTMF, hold, dials phone-3, swap, merge, hang up")
    ctl = await Sock(P2, "control").open("?takeover=1")
    mon = await Sock(P2, "monitor").open()
    check(ctl.hello["hfp"]["connected"], f"phone-2 hfp connected, chld={ctl.hello['hfp']['chld']}")
    r = await ctl.cmd(type="dial", to=NUM[PX])
    if not check(r["type"] == "ack" and r["result"]["call"]["state"] in ("dialing", "alerting"), "dial ack with new call"):
        return
    a = r["result"]["call"]["id"]
    check(await ctl.wait(ev("call.state", id=a, state="alerting"), 20), "call_a alerting")
    check(await answer_on(PX), "pixel4 answered")
    act = await ctl.wait(ev("call.state", id=a, state="active"), 20)
    check(act and act["call"].get("answeredAt"), "call_a active with answeredAt")
    await asyncio.sleep(1.5)
    pos0 = ctl.audio_bytes
    await ctl.ws.send(tone(1.0))
    await ctl.ws.send(json.dumps({"type": "mark", "name": "m1"}))
    t = time.time()
    m = await ctl.wait(lambda m: m["type"] == "mark" and m["name"] == "m1", 5, past=False)
    check(m and not m["cleared"] and 0.9 < time.time() - t < 1.4, f"mark m1 after 1 s of audio ({time.time() - t:.2f}s)")
    check(ctl.audio_bytes - pos0 > 16000, f"downlink audio flowing ({ctl.audio_bytes - pos0} bytes in ~1 s)")
    check(mon.audio_bytes > 0, f"monitor stereo audio flowing ({mon.audio_bytes} bytes)")
    r = await ctl.cmd(type="dtmf", digits="1#")
    check(r["type"] == "ack", "dtmf ack")
    r = await ctl.cmd(type="hold")
    check(r["type"] == "ack" and [c["state"] for c in r["result"]["calls"]] == ["held"], "hold ack, call_a held")
    r = await ctl.cmd(type="dial", to=NUM[P3])
    if not check(r["type"] == "ack", "dial phone-3 ack"):
        return
    b = r["result"]["call"]["id"]
    check(await answer_on(P3), "phone-3 answered")
    check(await ctl.wait(ev("call.state", id=b, state="active"), 20), "call_b active")
    await asyncio.sleep(2)
    r = await ctl.cmd(type="swap")
    st = {c["id"]: c["state"] for c in r.get("result", {}).get("calls", [])}
    check(r["type"] == "ack" and st == {a: "active", b: "held"}, f"swap ack {st}")
    await asyncio.sleep(2)
    r = await ctl.cmd(type="merge")
    calls = r.get("result", {}).get("calls", [])
    check(r["type"] == "ack" and len(calls) == 2 and all(c["conference"] and c["state"] == "active" for c in calls)
          and {c["id"] for c in calls} == {a, b}, f"merge ack, ids kept: {[(c['id'], c['state'], c['conference']) for c in calls]}")
    await asyncio.sleep(3)
    r = await ctl.cmd(type="hangup")
    check(r["type"] == "ack", "hangup ack")
    ea = await ctl.wait(ev("call.ended", id=a), 10)
    eb = await ctl.wait(ev("call.ended", id=b), 10)
    check(ea and eb and ea["reason"] == "local" and eb["reason"] == "local", "both legs ended, reason local")
    check(await idle(PX) and await idle(P3), "pixel4 and phone-3 idle")
    links = [m["up"] for m in ctl.events if m["type"] == "audio.link"]
    check(links[:1] == [True], f"audio.link events {links}")
    check(any(m["type"] == "call.ended" for m in mon.events), "monitor saw call events")
    await mon.close()
    await ctl.close()


async def scenario_b():
    log("=== B: pixel4 calls phone-2 (Samsung: caller ID from the kiosk), phone-2 answers, pixel4 hangs up")
    ctl = await Sock(P2, "control").open("?takeover=1")
    t = time.time()
    st, body = await arest(PX, "POST", "dial", {"to": NUM[P2]})
    check(st == 200, f"pixel4 REST dial {st} {body.get('error', '')}")
    # The REST dial only returns once pixel4 sees its call, by which time
    # phone-2 may already have announced it.
    inc = await ctl.wait(ev("call.incoming"), 40)
    if not check(inc, "phone-2 call.incoming"):
        return
    c = inc["call"]
    check(c["number"] == NUM[PX], f"caller id {c['number']} via {c.get('numberSource')} after {inc['_t'] - t:.1f}s")
    await asyncio.sleep(2)
    r = await ctl.cmd(type="answer")
    check(r["type"] == "ack" and r["result"]["call"]["state"] == "active" and r["result"]["call"]["id"] == c["id"],
          "answer ack, same call id")
    await asyncio.sleep(3)
    st, body = await arest(PX, "POST", "hangup")
    check(st == 200, "pixel4 hangs up")
    e = await ctl.wait(ev("call.ended", id=c["id"]), 10)
    check(e and e["reason"] == "remote", f"ended reason {e and e['reason']}")
    await ctl.close()


async def scenario_c():
    log("=== C: phone-2 calls phone-3 (Pixel: caller ID over HFP), phone-3 rejects")
    ctl2 = await Sock(P2, "control").open("?takeover=1")
    ctl3 = await Sock(P3, "control").open("?takeover=1")
    r = await ctl2.cmd(type="dial", to=NUM[P3])
    if not check(r["type"] == "ack", "dial ack"):
        return
    a = r["result"]["call"]["id"]
    inc = await ctl3.wait(ev("call.incoming"), 40, past=False)
    if not check(inc, "phone-3 call.incoming"):
        return
    check(inc["call"]["number"] == NUM[P2], f"caller id {inc['call']['number']} via {inc['call'].get('numberSource')}")
    await asyncio.sleep(2)
    r = await ctl3.cmd(type="reject")
    check(r["type"] == "ack", "reject ack")
    e3 = await ctl3.wait(ev("call.ended", id=inc["call"]["id"]), 10)
    check(e3 and e3["reason"] == "rejected", f"phone-3 ended reason {e3 and e3['reason']}")
    # A rejected call goes to the callee's voicemail, which answers: the
    # caller's call either ends or becomes active.
    e2 = await ctl2.wait(lambda m: m.get("call", {}).get("id") == a and (m["type"] == "call.ended" or m["call"]["state"] == "active"), 40)
    check(e2 is not None, f"phone-2 call {'ended (' + e2['reason'] + ')' if e2 and e2['type'] == 'call.ended' else 'answered by voicemail' if e2 else 'still ringing'}")
    r = await ctl2.cmd(type="hangup") if e2 and e2["type"] != "call.ended" else None
    await ctl3.close()
    await ctl2.close()


async def scenario_d():
    log("=== D: pixel4 dials phone-3, audio + mark, DTMF, hold, resume, hang up")
    ctl = await Sock(PX, "control").open("?takeover=1")
    mon = await Sock(PX, "monitor").open()
    check(ctl.hello["hfp"]["connected"], f"pixel4 hfp connected, chld={ctl.hello['hfp']['chld']}")
    r = await ctl.cmd(type="dial", to=NUM[P3])
    if not check(r["type"] == "ack" and r["result"]["call"]["direction"] == "outgoing", "dial ack with new call"):
        return
    a = r["result"]["call"]["id"]
    check(await answer_on(P3), "phone-3 answered")
    act = await ctl.wait(ev("call.state", id=a, state="active"), 20)
    check(act and act["call"].get("answeredAt"), "active with answeredAt")
    await asyncio.sleep(1.5)
    pos0 = ctl.audio_bytes
    await ctl.ws.send(tone(1.0))
    await ctl.ws.send(json.dumps({"type": "mark", "name": "m1"}))
    t = time.time()
    m = await ctl.wait(lambda m: m["type"] == "mark" and m["name"] == "m1", 5, past=False)
    check(m and not m["cleared"] and 0.9 < time.time() - t < 1.4, f"mark m1 after 1 s of audio ({time.time() - t:.2f}s)")
    check(ctl.audio_bytes - pos0 > 16000, f"downlink audio flowing ({ctl.audio_bytes - pos0} bytes in ~1 s)")
    check(mon.audio_bytes > 0, f"monitor stereo audio flowing ({mon.audio_bytes} bytes)")
    r = await ctl.cmd(type="dtmf", digits="1#")
    check(r["type"] == "ack", "dtmf ack")
    r = await ctl.cmd(type="hold")
    check(r["type"] == "ack" and [c["state"] for c in r["result"]["calls"]] == ["held"], "hold ack")
    r = await ctl.cmd(type="resume")
    check(r["type"] == "ack" and [c["state"] for c in r["result"]["calls"]] == ["active"], "resume ack")
    r = await ctl.cmd(type="swap")
    check(r["type"] == "error" and r["code"] == "invalid_state", "swap with one call -> invalid_state")
    r = await ctl.cmd(type="hangup")
    check(r["type"] == "ack", "hangup ack")
    e = await ctl.wait(ev("call.ended", id=a), 10)
    check(e and e["reason"] == "local", f"ended reason {e and e['reason']}")
    check(await idle(P3), "phone-3 idle")
    links = [m["up"] for m in ctl.events if m["type"] == "audio.link"]
    check(links[:1] == [True], f"audio.link events {links}")
    await mon.close()
    await ctl.close()


async def main():
    which = sys.argv[1:] or ["A", "B", "C"]
    try:
        for s in which:
            await {"A": scenario_a, "B": scenario_b, "C": scenario_c, "D": scenario_d}[s]()
            await cleanup()
            await asyncio.sleep(3)
    finally:
        await cleanup()
    fails = [w for ok, w in RESULTS if not ok]
    log(f"{len(RESULTS) - len(fails)}/{len(RESULTS)} passed")
    for w in fails:
        log("  FAILED:", w)


asyncio.run(main())
