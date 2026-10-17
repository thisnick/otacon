import { definePluginEntry, type PluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { jsonResult } from "openclaw/plugin-sdk/tool-results";
import { isE164, parseConfig, type Contact } from "./config.js";
import { realtimeSdk } from "./realtime.js";
import { OtaconVoiceRuntime } from "./runtime.js";

const TOOL_NAME = "otacon_call";

const toolParameters = {
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
    callId: { type: "string", description: "end: the call id returned by call" },
  },
  required: ["action"],
};

function agentFromSessionKey(key?: string): string | undefined {
  const m = key?.match(/^agent:([^:]+):/);
  return m?.[1];
}

export default definePluginEntry({
  id: "otacon-voice",
  name: "Otacon Voice",
  description: "Phone calls through an otacon phone, run by a realtime voice model.",
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
    }) => {
      if (!runtime) throw new Error("otacon-voice is not running in this process");
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
      });
    };

    api.registerTool((ctx) => ({
      name: TOOL_NAME,
      label: "Phone call",
      description:
        "Place a phone call that a voice assistant carries out on the user's behalf: it navigates phone menus, waits on hold, talks to people, and can bring in one of the given contacts. Returns at once with a callId. The outcome (summary and transcript) is delivered to this session automatically as a system message when the call ends, which can take many minutes: do not poll `status` or sleep waiting for it. Tell the user the call is under way and end your turn.",
      parameters: toolParameters,
      async execute(_id: string, p: any) {
        try {
          if (p.action === "call") {
            if (!p.to || !p.brief) return jsonResult({ error: "call needs `to` and `brief`" });
            const r = await start({
              to: p.to,
              name: p.name,
              brief: p.brief,
              contacts: p.contacts,
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

    api.registerService({
      id: "otacon-voice",
      async start(ctx) {
        if (api.registrationMode !== "full") return;
        if (process.env.OPENCLAW_CLI === "1" && !process.argv.includes("gateway")) return;
        runtime = new OtaconVoiceRuntime(api, config, realtimeSdk);
        try {
          await runtime.start();
          api.logger.info(`[otacon-voice] running on ${config.otacon.phoneId}`);
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
