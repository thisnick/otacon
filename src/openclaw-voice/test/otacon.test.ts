import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { OtaconCommandError, OtaconLink } from "../src/otacon.js";
import { logger, settle } from "./fakes.js";

/** Stand-in for the global WebSocket: records sends, lets the test play the server. */
class FakeWS {
  static last: FakeWS;
  sent: any[] = [];
  binaryType = "";
  onopen?: () => void;
  onclose?: (ev: { code: number }) => void;
  onmessage?: (ev: { data: unknown }) => void;
  onerror?: () => void;
  constructor(public url: string) {
    FakeWS.last = this;
    setImmediate(() => this.onopen?.());
  }
  send(d: unknown) {
    this.sent.push(typeof d === "string" ? JSON.parse(d) : d);
  }
  close() {
    this.onclose?.({ code: 1000 });
  }
  server(msg: unknown) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
}

const realWS = globalThis.WebSocket;
afterEach(() => {
  (globalThis as any).WebSocket = realWS;
});

async function open() {
  (globalThis as any).WebSocket = FakeWS;
  const link = new OtaconLink({ url: "https://otacon.test:8080", phoneId: "phone-x", takeover: true, logger });
  link.start();
  await settle();
  return { link, ws: FakeWS.last };
}

test("connects to ws/voice/control and reads hello", async () => {
  const { link, ws } = await open();
  assert.equal(ws.url, "wss://otacon.test:8080/phones/phone-x/ws/voice/control?takeover=1");
  ws.server({ type: "hello", audio: { sampleRate: 16000 }, hfp: { connected: true }, calls: [{ id: "c1", state: "active" }] });
  assert.equal(link.hfpConnected, true);
  assert.equal(link.calls.get("c1")?.state, "active");
  link.stop();
});

test("commands resolve on their ack and reject on their error", async () => {
  const { link, ws } = await open();
  const a = link.cmd("hold");
  const b = link.cmd("merge");
  const [ha, hb] = ws.sent;
  assert.equal(ha.type, "hold");
  assert.notEqual(ha.id, hb.id);
  ws.server({ type: "error", id: hb.id, code: "unsupported", message: "no AT+CHLD=3" });
  ws.server({ type: "ack", id: ha.id, result: { calls: [] } });
  assert.deepEqual(await a, { calls: [] });
  await assert.rejects(b, (e: unknown) => e instanceof OtaconCommandError && e.code === "unsupported");
  link.stop();
});

test("marks resolve when playback reaches them; call events update the calls", async () => {
  const { link, ws } = await open();
  const seen: string[] = [];
  link.on("call", (m) => seen.push(`${m.type}:${m.call.state}`));
  const done = link.mark();
  const m = ws.sent.at(-1);
  assert.equal(m.type, "mark");
  assert.equal(m.id, undefined, "marks carry no command id");
  ws.server({ type: "mark", name: m.name, cleared: false });
  assert.equal(await done, false);
  ws.server({ type: "call.state", call: { id: "c1", state: "held" } });
  ws.server({ type: "call.ended", call: { id: "c1", state: "ended" }, reason: "remote" });
  assert.deepEqual(seen, ["call.state:held", "call.ended:ended"]);
  assert.equal(link.calls.size, 0);
  link.stop();
});

test("a closed socket fails pending commands", async () => {
  const { link, ws } = await open();
  const p = link.cmd("dial", { to: "+15555550100" });
  link.stop();
  ws.close();
  await assert.rejects(p, (e: unknown) => e instanceof OtaconCommandError && e.code === "disconnected");
});
