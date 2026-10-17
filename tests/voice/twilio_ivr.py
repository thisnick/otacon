"""Fake restaurant phone menu on Twilio, for testing DTMF and (later) the
voice plugin's menu navigation and hold handling.

  setup   create/update the Studio flow and buy a number pointed at it
  test    phone-2 calls the number, presses 1, 2, 3 over ws/voice/control,
          records both sides from ws/voice/monitor, then checks which
          digits Twilio received (Studio execution steps)

Credentials: TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN (environment, or
1Password via fleet.local.json's secrets). The flow and number live in
fleet.local.json's twilioIvr; setup writes them there.

  uv run --managed-python --no-project --with websockets python tests/voice/twilio_ivr.py setup|test
"""
import asyncio
import base64
import json
import os
import ssl
import sys
import time
import urllib.parse
import urllib.request
import wave

import fleet

HERE = os.path.dirname(os.path.abspath(__file__))
HOST = fleet.HOST
CALLER = fleet.host_id("phone-2")
VOICE, HOST_VOICE = "Polly.Joanna", "Polly.Matthew"
HOLD_MUSIC = "https://com.twilio.music.classical.s3.amazonaws.com/BusyStrings.mp3"


def load_env():
    sid, token = fleet.secret("TWILIO_ACCOUNT_SID"), fleet.secret("TWILIO_AUTH_TOKEN")
    return sid, "Basic " + base64.b64encode(f"{sid}:{token}".encode()).decode()


def load_state():
    ivr = fleet.F.get("twilioIvr") or {}
    return {"flow": ivr.get("flowSid"), "number_sid": ivr.get("numberSid"), "number": ivr.get("number")}


def save_state(state):
    path = fleet.ROOT / "fleet.local.json"
    data = json.loads(path.read_text())
    data["twilioIvr"] = {"number": state["number"], "flowSid": state["flow"], "numberSid": state["number_sid"]}
    path.write_text(json.dumps(data, indent=2))


ACCOUNT, AUTH = load_env()


def api(method, url, form=None):
    data = urllib.parse.urlencode(form, doseq=True).encode() if form is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers={"Authorization": AUTH})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        sys.exit(f"{method} {url} -> {e.code} {e.read()[:300]!r}")


def say(name, text, nxt, voice=VOICE):
    return {"name": name, "type": "say-play", "properties": {"say": text, "voice": voice, "loop": 1},
            "transitions": [{"event": "audioComplete", **({"next": nxt} if nxt else {})}]}


def flow_definition():
    menu_text = ("Thanks for calling Luigi's Trattoria. For our location and hours, press 1. "
                 "For prices, press 2. To make a reservation, press 3.")
    states = [
        {"name": "Trigger", "type": "trigger", "properties": {},
         "transitions": [{"event": "incomingMessage"}, {"event": "incomingCall", "next": "menu"},
                         {"event": "incomingConversationMessage"}, {"event": "incomingRequest"},
                         {"event": "incomingParent"}]},
        {"name": "menu", "type": "gather-input-on-call",
         "properties": {"say": menu_text, "voice": VOICE, "number_of_digits": 1, "timeout": 8,
                        "stop_gather": True, "gather_language": "en", "loop": 1,
                        "speech_timeout": "auto", "profanity_filter": "true"},
         "transitions": [{"event": "keypress", "next": "route"}, {"event": "speech", "next": "menu"},
                         {"event": "timeout", "next": "goodbye"}]},
        {"name": "route", "type": "split-based-on", "properties": {"input": "{{widgets.menu.Digits}}"},
         "transitions": [{"event": "noMatch", "next": "invalid"}] + [
             {"event": "match", "next": nxt, "conditions": [
                 {"friendly_name": d, "arguments": ["{{widgets.menu.Digits}}"], "type": "equal_to", "value": d}]}
             for d, nxt in (("1", "location"), ("2", "prices"), ("3", "reserve"))]},
        say("location", "We are at 1 2 3 Main Street in Oakland, open every day from 5 to 10 PM.", "menu"),
        say("prices", "Pasta dishes are 18 to 26 dollars, and pizzas are 15 to 22 dollars.", "menu"),
        say("invalid", "Sorry, that's not a valid option.", "menu"),
        say("reserve", "Please hold while I connect you to our host.", "hold"),
        {"name": "hold", "type": "say-play",
         "properties": {"play": HOLD_MUSIC, "loop": 1},
         "transitions": [{"event": "audioComplete", "next": "host"}]},
        {"name": "host", "type": "gather-input-on-call",
         "properties": {"say": "Hi, this is Marco at Luigi's. How many people, and what time would you like?",
                        "voice": HOST_VOICE, "speech_timeout": "auto", "timeout": 8, "gather_language": "en-US",
                        "stop_gather": True, "loop": 1, "profanity_filter": "true"},
         "transitions": [{"event": "keypress", "next": "host_done"}, {"event": "speech", "next": "host_done"},
                         {"event": "timeout", "next": "goodbye"}]},
        # No next state: the flow ends and Twilio hangs up.
        say("host_done", "Great, you're all set. See you then. Goodbye!", None, voice=HOST_VOICE),
        say("goodbye", "Thanks for calling Luigi's. Goodbye!", None),
    ]
    return {"description": "Fake restaurant IVR for otacon tests", "states": states,
            "initial_state": "Trigger", "flags": {"allow_concurrent_calls": True}}


def setup():
    state = {k: v for k, v in load_state().items() if v and not v.startswith(("FWxxx", "PNxxx"))}
    form = {"FriendlyName": "otacon-test-luigis", "Status": "published",
            "Definition": json.dumps(flow_definition())}
    if state.get("flow"):
        flow = api("POST", f"https://studio.twilio.com/v2/Flows/{state['flow']}", form)
    else:
        flow = api("POST", "https://studio.twilio.com/v2/Flows", form)
    state["flow"] = flow["sid"]
    print("flow", flow["sid"], flow.get("status"), "errors:", flow.get("errors") or "none")
    webhook = f"https://webhooks.twilio.com/v1/Accounts/{ACCOUNT}/Flows/{flow['sid']}"
    base = f"https://api.twilio.com/2010-04-01/Accounts/{ACCOUNT}"
    if not state.get("number_sid"):
        avail = api("GET", f"{base}/AvailablePhoneNumbers/US/Local.json?VoiceEnabled=true&AreaCode=510&PageSize=1")
        if not avail.get("available_phone_numbers"):
            avail = api("GET", f"{base}/AvailablePhoneNumbers/US/Local.json?VoiceEnabled=true&PageSize=1")
        num = avail["available_phone_numbers"][0]["phone_number"]
        bought = api("POST", f"{base}/IncomingPhoneNumbers.json",
                     {"PhoneNumber": num, "FriendlyName": "otacon test IVR (Luigi's)", "VoiceUrl": webhook,
                      "VoiceMethod": "POST"})
        state["number_sid"], state["number"] = bought["sid"], bought["phone_number"]
        print("bought", state["number"])
    else:
        api("POST", f"{base}/IncomingPhoneNumbers/{state['number_sid']}.json", {"VoiceUrl": webhook, "VoiceMethod": "POST"})
        print("number", state["number"], "points at the flow")
    save_state(state)


async def run_test(digits=("1", "2", "3"), gap=9.0, out=None):
    import websockets
    state = load_state()
    ctx = ssl.create_default_context()
    out = out or os.path.join(os.getcwd(), f"ivr-{time.strftime('%Y%m%d-%H%M%S')}.wav")
    t0 = time.time()
    log = lambda *a: print(f"+{time.time() - t0:6.2f}s", *a, flush=True)
    ctl = await websockets.connect(f"wss://{HOST}/phones/{CALLER}/ws/voice/control?takeover=1", ssl=ctx, max_size=None)
    mon = await websockets.connect(f"wss://{HOST}/phones/{CALLER}/ws/voice/monitor", ssl=ctx, max_size=None)
    hello = json.loads(await ctl.recv())
    mhello = json.loads(await mon.recv())
    rate = mhello["audio"]["sampleRate"]
    wav = wave.open(out, "wb")
    wav.setnchannels(2)
    wav.setsampwidth(2)
    wav.setframerate(rate)
    replies, events = {}, []

    async def read_ctl():
        async for m in ctl:
            if isinstance(m, str):
                msg = json.loads(m)
                if msg["type"] in ("ack", "error") and msg.get("id"):
                    replies[msg["id"]] = msg
                else:
                    events.append(msg)
                    if msg["type"].startswith("call."):
                        c = msg["call"]
                        log(msg["type"], c["id"], c["state"], msg.get("reason", ""))

    async def read_mon():
        async for m in mon:
            if isinstance(m, bytes):
                wav.writeframes(m)

    tasks = [asyncio.create_task(read_ctl()), asyncio.create_task(read_mon())]
    n = 0

    async def cmd(**c):
        nonlocal n
        n += 1
        cid = str(n)
        await ctl.send(json.dumps({**c, "id": cid}))
        while cid not in replies:
            await asyncio.sleep(0.05)
        r = replies.pop(cid)
        log(c["type"], c.get("digits", c.get("to", "")), "->", r["type"], r.get("code", ""), r.get("message", ""))
        return r

    log("hfp", hello["hfp"])
    r = await cmd(type="dial", to=state["number"])
    call = r.get("result", {}).get("call", {}).get("id")
    while not any(e["type"] == "call.state" and e["call"]["id"] == call and e["call"]["state"] == "active" for e in events):
        await asyncio.sleep(0.2)
    started = time.time()
    log("answered; waiting for the menu prompt")
    await asyncio.sleep(7.5)
    for d in digits:
        await cmd(type="dtmf", digits=d)
        await asyncio.sleep(gap if d != "3" else 40)
    await cmd(type="hangup")
    await asyncio.sleep(1)
    for t in tasks:
        t.cancel()
    wav.close()
    await ctl.close()
    await mon.close()
    log("recorded", out)

    # Which digits did Twilio get? The newest execution of the flow.
    ex = api("GET", f"https://studio.twilio.com/v2/Flows/{state['flow']}/Executions?PageSize=1")["executions"][0]
    steps = api("GET", f"https://studio.twilio.com/v2/Flows/{state['flow']}/Executions/{ex['sid']}/Steps?PageSize=50")["steps"]
    path = [f"{s['transitioned_from']}->{s['transitioned_to']} ({s['name']})" for s in reversed(steps)]
    print("studio path:\n  " + "\n  ".join(path))
    got = [s["transitioned_to"] for s in reversed(steps) if s["transitioned_from"] == "route"]
    want = [{"1": "location", "2": "prices", "3": "reserve"}[d] for d in digits]
    print("RESULT", "PASS" if got == want else "FAIL", "branches", got, "expected", want,
          f"(call {time.time() - started:.0f}s)")


if __name__ == "__main__":
    {"setup": setup, "test": lambda: asyncio.run(run_test())}[sys.argv[1]]()
