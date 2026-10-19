import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { MuLawToPcm16k, Pcm16kToMuLaw, muLawDecode, muLawEncode } from "../src/g711.js";
import { TwilioLine } from "../src/twilio.js";
import { logs, settle } from "./fakes.js";

const TOKEN = "auth-token";
const PUBLIC = "https://gw.example.ts.net/otacon-voice/twilio/tw";
const logger = { info: (m: string) => void logs.push(m), warn: (m: string) => void logs.push(m), error: (m: string) => void logs.push(m) };

/** Twilio's REST API: records requests, answers calls with sids. */
function fakeTwilio() {
  const requests: { method: string; url: string; form: URLSearchParams }[] = [];
  let n = 0;
  const fetchImpl = (async (url: string, init: any) => {
    const form = new URLSearchParams(init.body ? String(init.body) : "");
    requests.push({ method: init.method, url, form });
    if (url.endsWith("/Calls.json")) return new Response(JSON.stringify({ sid: `CA${++n}` }), { status: 201 });
    return new Response(JSON.stringify({}), { status: 200 });
  }) as any;
  return { requests, fetchImpl };
}

function line(screen?: (n: string | null) => boolean) {
  const tw = fakeTwilio();
  const l = new TwilioLine({
    id: "tw",
    accountSid: "AC1",
    authToken: TOKEN,
    fromNumber: "+15550009999",
    publicUrl: PUBLIC,
    ringTimeoutSeconds: 20,
    logger: logger as any,
    fetchImpl: tw.fetchImpl,
  });
  l.screen = screen;
  const events: any[] = [];
  l.on("call", (m) => events.push(m));
  return { l, tw, events };
}

/** A media stream socket as the ws server hands it over. */
class FakeSocket extends EventEmitter {
  sent: any[] = [];
  closed = false;
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.closed = true;
  }
  twilio(msg: unknown) {
    this.emit("message", Buffer.from(JSON.stringify(msg)));
  }
}

function stream(l: TwilioLine, callSid: string, token = (l as any).streamToken) {
  const ws = new FakeSocket();
  (l as any).onStreamSocket(ws);
  ws.twilio({ event: "connected" });
  ws.twilio({ event: "start", streamSid: `MZ${callSid}`, start: { callSid, customParameters: { token } } });
  return ws;
}

function sign(path: string, params: Record<string, string>) {
  let data = `${PUBLIC}/${path}`;
  for (const k of Object.keys(params).sort()) data += k + params[k];
  return createHmac("sha1", TOKEN).update(data).digest("base64");
}

/** A webhook request from Twilio (signed unless `signature` says otherwise). */
async function webhook(l: TwilioLine, path: string, params: Record<string, string>, signature = sign(path, params)) {
  const body = new URLSearchParams(params).toString();
  const req: any = (async function* () {
    yield Buffer.from(body);
  })();
  req.method = "POST";
  req.headers = signature ? { "x-twilio-signature": signature } : {};
  const res: any = { statusCode: 200, headers: {} as Record<string, string>, body: "" };
  res.setHeader = (k: string, v: string) => void (res.headers[k] = v);
  res.end = (b = "") => void (res.body = String(b));
  await l.handleHttp(path, "", req, res);
  return res;
}

async function ready(l: TwilioLine) {
  l.start();
  await settle();
  assert.equal(l.open, true);
}

test("g711: µ-law round trip, and 8 <-> 16 kHz keeps a tone's level", () => {
  for (const x of [0, 100, -100, 1000, -1000, 12000, -12000, 32000]) {
    const y = muLawDecode(muLawEncode(x));
    assert.ok(Math.abs(y - x) <= Math.max(8, Math.abs(x) * 0.07), `${x} -> ${y}`);
  }
  // A 1 kHz tone, 16 kHz -> µ-law 8 kHz -> 16 kHz.
  const n = 3200;
  const pcm = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) pcm.writeInt16LE(Math.round(8000 * Math.sin((2 * Math.PI * 1000 * i) / 16000)), i * 2);
  const mulaw = new Pcm16kToMuLaw().process(pcm);
  assert.equal(mulaw.length, n / 2);
  const back = new MuLawToPcm16k().process(mulaw);
  assert.equal(back.length, pcm.length);
  let sq = 0;
  for (let i = 400; i < n; i++) sq += back.readInt16LE(i * 2) ** 2;
  const rms = Math.sqrt(sq / (n - 400));
  assert.ok(rms > 8000 * 0.707 * 0.85 && rms < 8000 * 0.707 * 1.15, `rms ${rms}`);
});

test("dial: a REST call that streams back here, with status callbacks; then its states", async () => {
  const { l, tw, events } = line();
  await ready(l);
  const r = await l.cmd("dial", { to: "+15550001111" });
  assert.equal(r.call.id, "CA1");
  assert.equal(r.call.state, "dialing");
  const req = tw.requests.find((x) => x.url.endsWith("/Calls.json"))!;
  assert.equal(req.form.get("To"), "+15550001111");
  assert.equal(req.form.get("From"), "+15550009999");
  assert.match(req.form.get("Twiml")!, /<Connect><Stream url="wss:\/\/gw\.example\.ts\.net\/otacon-voice\/twilio\/tw\/stream"><Parameter name="token"/);
  assert.equal(req.form.get("StatusCallback"), `${PUBLIC}/status`);
  assert.deepEqual(req.form.getAll("StatusCallbackEvent"), ["initiated", "ringing", "answered", "completed"]);
  assert.equal(req.form.get("Timeout"), "25");

  assert.equal((await webhook(l, "status", { CallSid: "CA1", CallStatus: "ringing" })).statusCode, 204);
  assert.equal(l.calls.get("CA1")!.state, "alerting");
  assert.equal((await webhook(l, "status", { CallSid: "CA1", CallStatus: "in-progress" }, "bad")).statusCode, 403, "unsigned webhooks are refused");
  const answered = l.waitFor("CA1", ["active"], 1000);
  stream(l, "CA1");
  assert.equal((await answered)!.state, "active");
  await webhook(l, "status", { CallSid: "CA1", CallStatus: "completed" });
  assert.deepEqual(events.at(-1), { type: "call.ended", call: { ...events.at(-1).call, state: "ended" }, reason: "remote" });
  assert.equal(l.calls.size, 0);
});

test("stream: a wrong token is closed; audio both ways in 16 kHz; marks and clear", async () => {
  const { l } = line();
  await ready(l);
  await l.cmd("dial", { to: "+15550001111" });
  assert.equal(stream(l, "CA1", "nope").closed, true);
  const ws = stream(l, "CA1");
  const heard: Buffer[] = [];
  l.on("audio", (b) => heard.push(b));
  ws.twilio({ event: "media", media: { track: "inbound", payload: Buffer.alloc(160, 0xff).toString("base64") } });
  assert.equal(heard[0].length, 160 * 4, "20 ms of µ-law -> 20 ms of 16 kHz pcm");
  l.sendAudio(Buffer.alloc(640));
  const media = ws.sent.find((m) => m.event === "media");
  assert.equal(media.streamSid, "MZCA1");
  assert.equal(Buffer.from(media.media.payload, "base64").length, 160);

  const played = l.mark();
  const name = ws.sent.at(-1).mark.name;
  ws.twilio({ event: "mark", mark: { name } });
  assert.equal(await played, false);
  const cleared = l.mark();
  await l.clear();
  assert.equal(ws.sent.at(-1).event, "clear");
  assert.equal(await cleared, true);
});

test("dtmf: the call is redirected to <Play digits>, and back once the new stream starts", async () => {
  const { l, tw, events } = line();
  await ready(l);
  await l.cmd("dial", { to: "+15550001111" });
  const old = stream(l, "CA1");
  const pressed = l.cmd("dtmf", { digits: "3w1" });
  await settle();
  const redirect = tw.requests.at(-1)!;
  assert.match(redirect.url, /\/Calls\/CA1\.json$/);
  assert.match(redirect.form.get("Twiml")!, /^<Response><Play digits="3w1"\/><Connect><Stream /);
  old.twilio({ event: "stop" }); // the redirect ends the old stream: not the end of the call
  assert.equal(l.calls.get("CA1")!.state, "active");
  stream(l, "CA1");
  assert.deepEqual(await pressed, { digits: "3w1" });
  assert.equal(events.filter((e) => e.type === "call.ended").length, 0);
  await assert.rejects(l.cmd("dtmf", { digits: "1; drop" }), /bad_digits/);
});

test("hold, swap and merge: one call gets the audio; merge joins both in a conference", async () => {
  const { l, tw } = line();
  await ready(l);
  await l.cmd("dial", { to: "+15550001111" });
  const a = stream(l, "CA1");
  await l.cmd("hold");
  assert.equal(l.calls.get("CA1")!.state, "held");
  await l.cmd("dial", { to: "+15550002222" });
  const b = stream(l, "CA2");
  const heard: Buffer[] = [];
  l.on("audio", (x) => heard.push(x));
  a.twilio({ event: "media", media: { payload: Buffer.alloc(160).toString("base64") } });
  assert.equal(heard.length, 0, "the held call isn't heard");
  b.twilio({ event: "media", media: { payload: Buffer.alloc(160).toString("base64") } });
  assert.equal(heard.length, 1);
  await l.cmd("swap");
  assert.equal(l.calls.get("CA1")!.state, "active");
  assert.equal(l.calls.get("CA2")!.state, "held");
  l.sendAudio(Buffer.alloc(640));
  assert.equal(a.sent.filter((m) => m.event === "media").length, 1, "audio goes to the call taken off hold");
  assert.equal(b.sent.filter((m) => m.event === "media").length, 0);

  await l.cmd("merge");
  const conf = tw.requests.slice(-2).map((r) => r.form.get("Twiml"));
  assert.ok(conf.every((t) => /<Dial><Conference [^>]*endConferenceOnExit="true"[^>]*>otacon-[0-9a-f]+<\/Conference><\/Dial>/.test(t!)));
  assert.equal(conf[0], conf[1]);
  assert.ok([...l.calls.values()].every((c) => c.conference));
  a.twilio({ event: "stop" }); // the conference took over the call
  assert.equal(l.calls.size, 2);
});

test("incoming: rejected unless screened in; answered once the stream is up; our hang-up ends it as local", async () => {
  let take = false;
  const { l, tw, events } = line(() => take);
  await ready(l);
  const rejected = await webhook(l, "answer", { CallSid: "CA9", From: "+15550003333", To: "+15550009999" });
  assert.match(rejected.body, /<Response><Reject\/><\/Response>/);
  assert.equal(events.length, 0);

  take = true;
  const taken = await webhook(l, "answer", { CallSid: "CA10", From: "+15550003333", To: "+15550009999" });
  assert.match(taken.body, /<Connect><Stream url="wss:/);
  assert.equal(taken.headers["Content-Type"], "text/xml");
  assert.equal(events.at(-1).type, "call.incoming");
  assert.equal(events.at(-1).call.number, "+15550003333");
  const answered = l.cmd("answer", { call: "CA10" });
  stream(l, "CA10");
  assert.equal((await answered).call.state, "active");

  await l.cmd("hangup", { call: "CA10" });
  assert.equal(tw.requests.at(-1)!.form.get("Status"), "completed");
  (l as any).legs.get("CA10").ws.twilio({ event: "stop" });
  assert.equal(events.at(-1).type, "call.ended");
  assert.equal(events.at(-1).reason, "local");
});
