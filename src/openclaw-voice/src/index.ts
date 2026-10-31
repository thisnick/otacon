import { definePluginEntry, type PluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { jsonResult } from "openclaw/plugin-sdk/tool-results";
import { isE164, parseConfig, type Contact, type OtaconVoiceConfig } from "./config.js";
import type { IncomingMessage } from "node:http";
import { join } from "node:path";
import { realtimeSdk } from "./realtime.js";
import { OtaconVoiceRuntime } from "./runtime.js";

const TOOL_NAME = "otacon_call";

const describeLine = (l: OtaconVoiceConfig["lines"][number]) =>
  `${l.id}${l.number ? ` (${l.number})` : ""}: ${l.provider === "otacon" ? "a phone with a SIM" : "a Twilio number"}`;

/** Where the Twilio lines' routes live in the gateway: <prefix>/<line id>/<answer|status|stream>. */
const TWILIO_ROUTES = "/otacon-voice/twilio";

const toolParameters = (config: OtaconVoiceConfig) => ({
  type: "object",
  additionalProperties: false,
  properties: {
    action: {
      type: "string",
      enum: ["call", "end"],
      description: "call: place a phone call; end: hang up the current call",
    },
    to: { type: "string", description: "call: number to dial, E.164 (e.g. +15551234567)" },
    name: { type: "string", description: "call: who you're calling (e.g. the business name), used in the report" },
    brief: {
      type: "string",
      description:
        "call: what the call should achieve, with every detail the assistant may need and may share (names, dates, party size, account numbers it may give out)",
    },
    contacts: {
      type: "array",
      description: "call: people the assistant may bring into the call if needed (warm hand-off)",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          name: { type: "string" },
          number: { type: "string", description: "E.164" },
          description: { type: "string", description: "Who they are and when to bring them in" },
        },
        required: ["name", "number"],
      },
    },
    sessionKey: {
      type: "string",
      description:
        "call: the OpenClaw session the call runs in (its consults, so what the agent remembers of it). Default: one session per phone number, shared by every call with that number",
    },
    holdLimitMinutes: {
      type: "number",
      description: `call: how long to wait on hold before hanging up, in minutes (default ${minutes(config.holdCapSeconds)}; at most ${minutes(config.maxCallSeconds)}, the limit for the whole call). Holds are timed until a person answers.`,
    },
    ...(config.lines.length > 1
      ? {
          line: {
            type: "string",
            enum: config.lines.map((l) => l.id),
            description: `call: the line to call from (default ${config.defaultLine}). ${config.lines.map(describeLine).join("; ")}`,
          },
        }
      : {}),
    callId: { type: "string", description: "end: the call id returned by call" },
  },
  required: ["action"],
});

const minutes = (seconds: number) => String(Math.round((seconds / 60) * 10) / 10);

function agentFromSessionKey(key?: string): string | undefined {
  const m = key?.match(/^agent:([^:]+):/);
  return m?.[1];
}

export default definePluginEntry({
  id: "otacon-voice",
  name: "Otacon Voice",
  description: "Phone calls through otacon phones and Twilio numbers, run by a realtime voice model.",
  configSchema: {
    parse(value: unknown) {
      const { config, errors } = parseConfig(value);
      if (!config) throw new Error(errors.join("; "));
      return value;
    },
  },
  register(api: PluginApi) {
    const { config, errors } = parseConfig(api.pluginConfig ?? {});
    if (!config || !config.enabled) {
      if (errors.length) api.logger.warn(`[otacon-voice] disabled: ${errors.join("; ")}`);
      return;
    }
    let runtime: OtaconVoiceRuntime | undefined;

    const start = async (args: {
      to: string;
      name?: string;
      brief: string;
      contacts?: { name: string; number: string; description?: string }[];
      agentId?: string;
      requesterSessionKey?: string;
      sessionKey?: string;
      holdLimitMinutes?: number;
      line?: string;
    }) => {
      if (!runtime) throw new Error("otacon-voice is not running in this process");
      const hold = args.holdLimitMinutes;
      if (hold !== undefined && !(typeof hold === "number" && hold > 0)) throw new Error("`holdLimitMinutes` must be a positive number");
      const contacts: Contact[] = [];
      for (const [i, c] of (args.contacts ?? []).entries()) {
        if (!isE164(c.number)) throw new Error(`contact ${c.name}: number must be E.164`);
        contacts.push({ id: `p${i + 1}`, name: c.name, number: c.number, description: c.description });
      }
      return runtime.startCall({
        to: args.to,
        name: args.name,
        brief: args.brief,
        contacts,
        agentId: args.agentId ?? config.agentId ?? agentFromSessionKey(args.requesterSessionKey) ?? "main",
        requesterSessionKey: args.requesterSessionKey,
        sessionKey: args.sessionKey,
        holdLimitSeconds: hold === undefined ? undefined : hold * 60,
        line: args.line,
      });
    };

    api.registerTool((ctx) => ({
      name: TOOL_NAME,
      label: "Phone call",
      description:
        "Place a phone call that a voice assistant carries out on the user's behalf: it navigates phone menus, waits on hold, talks to people, and can bring in one of the given contacts. Returns at once with a callId. The outcome (a TL;DR and the end of the transcript; otacon_call_log has all of it) is delivered to this session automatically as a system message when the call ends, which can take many minutes: do not poll `status` or sleep waiting for it. Tell the user the call is under way and end your turn.",
      parameters: toolParameters(config),
      async execute(_id: string, p: any) {
        try {
          if (p.action === "call") {
            if (!p.to || !p.brief) return jsonResult({ error: "call needs `to` and `brief`" });
            const r = await start({
              to: p.to,
              name: p.name,
              brief: p.brief,
              contacts: p.contacts,
              sessionKey: p.sessionKey,
              holdLimitMinutes: p.holdLimitMinutes,
              line: p.line,
              agentId: ctx.agentId,
              requesterSessionKey: ctx.sessionKey,
            });
            return jsonResult({
              callId: r.missionId,
              status: "calling",
              note: "The call is running. Its outcome will be delivered to this session automatically when it ends; don't poll or wait for it. Tell the user it's under way and end your turn.",
            });
          }
          if (p.action === "status") {
            const st = runtime?.status(p.callId);
            if (!st) return jsonResult({ error: "no call" });
            return jsonResult(st.ended ? st : { ...st, note: "Still in progress. Don't poll: the outcome arrives here automatically when the call ends." });
          }
          if (p.action === "end") return jsonResult({ ended: runtime?.endCall(p.callId) ?? false });
          return jsonResult({ error: `unknown action ${p.action}` });
        } catch (err) {
          return jsonResult({ error: err instanceof Error ? err.message : String(err) });
        }
      },
    }));

    // For operators and scripted tests: same as the tool's "call".
    api.registerGatewayMethod(
      "otaconvoice.call",
      async ({ params, respond }) => {
        try {
          respond(true, await start(params ?? {}));
        } catch (err) {
          respond(false, undefined, { code: "INVALID_REQUEST", message: err instanceof Error ? err.message : String(err) });
        }
      },
      { scope: "operator.write" },
    );
    api.registerGatewayMethod(
      "otaconvoice.status",
      ({ params, respond }) => respond(true, runtime?.status(params?.callId) ?? null),
      { scope: "operator.read" },
    );

    // The whole report of a finished call: the session gets a TL;DR and the
    // end of the log; this has everything.
    api.registerTool(() => ({
      name: "otacon_call_log",
      label: "Phone call transcript",
      description:
        "The full transcript of a finished phone call made or answered with otacon_call: its TL;DR, goal and the whole call log, both sides, timestamped. The report a session gets when a call ends is shortened to a TL;DR and the end of the call; use this for the rest, or when asked for a call's transcript. Without callId, the most recent call.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: { callId: { type: "string", description: "the call id from otacon_call or the call report, e.g. oc_1234abcd" } },
      },
      async execute(_id: string, p: any) {
        if (!runtime) return jsonResult({ error: "otacon-voice is not running in this process" });
        const log = runtime.callLog(p?.callId || undefined);
        return jsonResult(log ?? { error: p?.callId ? `no saved transcript for ${p.callId}` : "no finished call yet" });
      },
    }));
    api.registerGatewayMethod(
      "otaconvoice.log",
      ({ params, respond }) => respond(true, runtime?.callLog(params?.callId || undefined) ?? null),
      { scope: "operator.read" },
    );

    // Listen-in: only when configured, with a line that can place the extra call.
    if (config.listen) {
      api.registerTool(() => ({
        name: "otacon_listen",
        label: "Listen in on a call",
        description:
          "Let the user listen in on a phone call in progress: start places a call to the user's configured number that plays both sides of the call (listen-only); stop hangs that up. Hanging up the listening call never ends the call itself, and the user can ask to listen again. Use it when the user asks to listen to a call.",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            action: { type: "string", enum: ["start", "stop"], description: "start: call the user to listen; stop: hang up the listening call" },
            callId: { type: "string", description: "the call id from otacon_call (default: the call in progress)" },
          },
          required: ["action"],
        },
        async execute(_id: string, p: any) {
          try {
            if (!runtime) return jsonResult({ error: "otacon-voice is not running in this process" });
            return jsonResult(await runtime.listen(p.action === "stop" ? "stop" : "start", p.callId));
          } catch (err) {
            return jsonResult({ error: err instanceof Error ? err.message : String(err) });
          }
        },
      }));
      api.registerGatewayMethod(
        "otaconvoice.listen",
        async ({ params, respond }) => {
          try {
            if (!runtime) throw new Error("otacon-voice is not running in this process");
            respond(true, await runtime.listen(params?.action === "stop" ? "stop" : "start", params?.callId));
          } catch (err) {
            respond(false, undefined, { code: "INVALID_REQUEST", message: err instanceof Error ? err.message : String(err) });
          }
        },
        { scope: "operator.write" },
      );
    }

    // Twilio lines: their webhooks and media streams, on the gateway. Twilio
    // signs what it sends; the routes check that themselves (auth "plugin").
    if (config.lines.some((l) => l.provider === "twilio")) {
      const route = (req: IncomingMessage) => {
        const url = new URL(req.url ?? "/", "http://gateway");
        const m = url.pathname.match(new RegExp(`^${TWILIO_ROUTES}/([^/]+)/([a-z]+)$`));
        const line = m ? runtime?.twilio(m[1]) : undefined;
        return line && m ? { line, path: m[2], query: url.search } : undefined;
      };
      api.registerHttpRoute({
        path: TWILIO_ROUTES,
        match: "prefix",
        auth: "plugin",
        handler: async (req, res) => {
          const r = route(req);
          if (!r || r.path === "stream") {
            res.statusCode = r ? 426 : 404;
            res.end();
            return true;
          }
          await r.line.handleHttp(r.path, r.query, req, res);
          return true;
        },
        handleUpgrade: (req, socket, head) => {
          const r = route(req);
          if (!r || r.path !== "stream") return false;
          r.line.handleUpgrade(req, socket, head);
          return true;
        },
      });
    }

    api.registerService({
      id: "otacon-voice",
      async start(ctx) {
        if (api.registrationMode !== "full") return;
        if (process.env.OPENCLAW_CLI === "1" && !process.argv.includes("gateway")) return;
        // OpenClaw's state directory (~/.openclaw): finished calls are saved there.
        runtime = new OtaconVoiceRuntime(api, config, realtimeSdk, { transcriptsDir: join(ctx.stateDir, "otacon-voice", "calls") });
        try {
          await runtime.start();
          api.logger.info(`[otacon-voice] running on ${runtime.lines.map((l) => l.label).join(", ")}`);
        } catch (err) {
          ctx.serviceHealth?.reportFailure(err);
        }
      },
      stop() {
        runtime?.stop();
        runtime = undefined;
      },
    });
  },
});
