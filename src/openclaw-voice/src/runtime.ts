// The plugin's long-lived side: the configured phone lines (otacon phones,
// Twilio numbers), each with at most one call mission at a time, inbound
// call screening, and reporting call outcomes back to the agent session
// that asked for the call.

import { AsyncResource } from "node:async_hooks";
import type { PluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { CallMission, type MenuDeps, type MissionReport, type Party, type RealtimeSdk, type SpeechDetectorLike } from "./call.js";
import { isE164, type Contact, type LineConfig, type OtaconVoiceConfig } from "./config.js";
import type { LineLink } from "./line.js";
import { OtaconLink } from "./otacon.js";
import { TwilioLine } from "./twilio.js";
import { openRouterDecisions } from "./navigator.js";
import { formatReport } from "./report.js";
import { openAiLiveTranscriber } from "./transcriber.js";
import { SpeechDetector } from "./vad.js";

export interface StartCall {
  to: string;
  name?: string;
  brief: string;
  /** People the assistant may bring in, beyond the configured contacts */
  contacts?: Contact[];
  agentId: string;
  requesterSessionKey?: string;
  /** The session to run the call in (default: config.sessionScope) */
  sessionKey?: string;
  /** Longest hold before the navigator hangs up (default: config.holdCapSeconds; at most maxCallSeconds) */
  holdLimitSeconds?: number;
  /** The line to call from (default: config.defaultLine) */
  line?: string;
}

/** One configured line: its link, its speech detector, its call. */
interface Slot {
  config: LineConfig;
  link?: LineLink;
  detector: SpeechDetectorLike | null;
  mission?: CallMission;
}

export class OtaconVoiceRuntime {
  private slots = new Map<string, Slot>();
  /**
   * The plugin service's async context, from start(). A call an agent places
   * runs in it, not in the agent turn that called the tool: OpenClaw closes
   * a turn's async work scope when the turn ends, and the call's consults
   * would then fail ("Async work scope is closed").
   */
  private home?: AsyncResource;
  private recent: MissionReport[] = [];

  constructor(
    private api: PluginApi,
    private config: OtaconVoiceConfig,
    private sdk: RealtimeSdk,
    /** Tests pass links by line id */
    private deps: { links?: Record<string, LineLink>; createDetector?: () => Promise<SpeechDetectorLike | null>; menu?: MenuDeps } = {},
  ) {
    for (const line of config.lines) this.slots.set(line.id, { config: line, detector: null });
    this.createDetector = deps.createDetector ?? (() => SpeechDetector.create());
    this.menu = deps.menu;
  }

  /** A line's link (tests, the Twilio routes). */
  link(id = this.config.defaultLine): LineLink | undefined {
    return this.slots.get(id)?.link;
  }

  /** The Twilio line with this id, for its routes. */
  twilio(id: string): TwilioLine | undefined {
    const link = this.slots.get(id)?.link;
    return link instanceof TwilioLine ? link : undefined;
  }

  private async createLink(line: LineConfig): Promise<LineLink | undefined> {
    const given = this.deps.links?.[line.id];
    if (given) return given;
    if (line.provider === "otacon") return new OtaconLink({ url: line.url, phoneId: line.phoneId, takeover: line.takeover, logger: this.api.logger });
    const authToken = await this.secret(line.authToken);
    if (!authToken) {
      this.api.logger.warn(`[otacon-voice] line ${line.id}: no Twilio auth token (authToken); the line is off`);
      return undefined;
    }
    return new TwilioLine({
      id: line.id,
      accountSid: line.accountSid,
      authToken,
      fromNumber: line.fromNumber,
      publicUrl: line.publicUrl,
      ringTimeoutSeconds: this.config.ringTimeoutSeconds,
      logger: this.api.logger,
    });
  }

  private createDetector: () => Promise<SpeechDetectorLike | null>;
  /** The phone-menu navigator for agent-placed calls; absent when it's off. */
  private menu?: MenuDeps;

  async start() {
    this.home = new AsyncResource("otacon-voice.call");
    this.menu ??= await this.buildMenu();
    for (const slot of this.slots.values()) {
      // One detector per line: it keeps state, and lines can have calls at once.
      slot.detector = await this.createDetector().catch(() => null);
      slot.link = await this.createLink(slot.config);
      if (!slot.link) continue;
      slot.link.screen = (number) => this.takes(slot, number);
      const home = this.home;
      if (slot.link.runIn) slot.link.runIn = (fn) => home.runInAsyncScope(fn);
      slot.link.on("call", (msg) => this.onCall(slot, msg));
      slot.link.start();
    }
    if ([...this.slots.values()].some((s) => !s.detector))
      this.api.logger.warn("[otacon-voice] speech detector unavailable (onnxruntime-node); the phone-menu navigator won't time holds");
  }

  /** The lines, for logs and the tool description. */
  get lines(): { id: string; provider: string; number?: string; label: string }[] {
    return [...this.slots.values()].map((s) => ({
      id: s.config.id,
      provider: s.config.provider,
      number: s.config.number,
      label: s.link?.label ?? s.config.id,
    }));
  }

  /**
   * The navigator's decision model and live transcriber, from the keys in
   * the plugin config (strings or SecretRefs). Resolved once at start; off
   * without them.
   */
  private async buildMenu(): Promise<MenuDeps | undefined> {
    const m = this.config.menu;
    if (!m.enabled) return undefined;
    const log = this.api.logger;
    const decisionsKey = await this.secret(m.decisions.apiKey);
    if (!decisionsKey) {
      log.info("[otacon-voice] phone-menu navigator off: no OpenRouter key (menu.decisions.apiKey)");
      return undefined;
    }
    // The live transcript uses the realtime voice model's OpenAI key unless it has its own.
    const sttKey =
      (await this.secret(m.transcription.apiKey)) ??
      (await this.secret(this.config.realtime.providers.openai?.apiKey)) ??
      (process.env.OPENAI_API_KEY?.trim() || undefined);
    if (!sttKey) {
      log.info("[otacon-voice] phone-menu navigator off: no OpenAI key for the live transcript");
      return undefined;
    }
    log.info(`[otacon-voice] phone-menu navigator on (${m.decisions.model}; ${m.transcription.model}, delay ${m.transcription.delay})`);
    const decisions = openRouterDecisions({ apiKey: decisionsKey, model: m.decisions.model });
    return {
      decisions,
      openTranscriber: (handlers) =>
        openAiLiveTranscriber({
          apiKey: sttKey,
          model: m.transcription.model,
          delay: m.transcription.delay,
          prompt: "A phone call: an automated phone menu, hold messages, or a person.",
          ...handlers,
        }),
    };
  }

  /** A config secret: a plain string, or a SecretRef resolved by OpenClaw. */
  private async secret(value: unknown): Promise<string | undefined> {
    if (typeof value === "string") return value.trim() || undefined;
    if (!value || typeof value !== "object") return undefined;
    try {
      const values = await this.sdk.resolveSecretRefs([value], { config: this.api.config });
      const v = [...values.values()][0];
      return typeof v === "string" && v.trim() ? v.trim() : undefined;
    } catch (err) {
      this.api.logger.warn(`[otacon-voice] couldn't resolve a secret: ${String(err).slice(0, 160)}`);
      return undefined;
    }
  }

  stop() {
    for (const slot of this.slots.values()) {
      slot.mission?.finish("ended_by_agent", "The gateway stopped.");
      slot.link?.stop();
    }
  }

  private busy(slot: Slot) {
    return Boolean(slot.mission && !slot.mission.status.ended);
  }

  /** Missions under way, newest first. */
  private live(): CallMission[] {
    return [...this.slots.values()].flatMap((s) => (s.mission && this.busy(s) ? [s.mission] : [])).reverse();
  }

  status(missionId?: string) {
    const all = [...this.slots.values()].flatMap((s) => (s.mission ? [s.mission] : []));
    const m = missionId ? all.find((x) => x.id === missionId) : (this.live()[0] ?? all.at(-1));
    if (m) return m.status;
    const r = this.recent.find((r) => r.missionId === missionId);
    return r ? { missionId: r.missionId, ended: true, outcome: r.outcome, summary: r.summary } : null;
  }

  async startCall(req: StartCall): Promise<{ missionId: string }> {
    const id = req.line ?? this.config.defaultLine;
    const slot = this.slots.get(id);
    if (!slot) throw new Error(`no line ${id}; lines: ${[...this.slots.keys()].join(", ")}`);
    if (!slot.link?.open) throw new Error(`line ${id} isn't connected`);
    if (this.busy(slot)) throw new Error(`a call is already in progress on line ${id}`);
    if (!isE164(req.to)) throw new Error("`to` must be an E.164 number like +15551234567");
    const contacts = [...this.config.contacts, ...(req.contacts ?? [])];
    const known = contacts.find((c) => c.number === req.to);
    const party: Party = { name: req.name?.trim() || known?.name || req.to, number: req.to, role: "primary" };
    const mission = this.newMission(slot, {
      direction: "outbound",
      party,
      brief: req.brief,
      contacts,
      agentId: req.agentId,
      requesterSessionKey: req.requesterSessionKey,
      sessionKey: req.sessionKey,
      holdLimitSeconds:
        req.holdLimitSeconds === undefined ? undefined : Math.min(Math.max(10, Math.round(req.holdLimitSeconds)), this.config.maxCallSeconds),
      menu: this.menu,
    });
    this.home ? this.home.runInAsyncScope(() => mission.start()) : mission.start();
    return { missionId: mission.id };
  }

  endCall(missionId?: string) {
    const live = this.live();
    const m = missionId ? live.find((x) => x.id === missionId) : live.length === 1 ? live[0] : undefined;
    if (!m) return false;
    m.finish("ended_by_agent", "Ended at the agent's request.", { lastWords: true });
    return true;
  }

  private newMission(slot: Slot, o: {
    direction: "outbound" | "inbound";
    party: Party;
    brief?: string;
    contacts: Contact[];
    agentId: string;
    requesterSessionKey?: string;
    sessionKey?: string;
    holdLimitSeconds?: number;
    menu?: MenuDeps;
    inboundCallId?: string;
  }) {
    const mission = new CallMission({
      api: this.api,
      config: this.config,
      link: slot.link!,
      line: { id: slot.config.id, number: slot.config.number },
      sdk: this.sdk,
      detector: slot.detector,
      ...o,
      onEnd: (report) => this.onMissionEnd(report),
    });
    slot.mission = mission;
    return mission;
  }

  /** Whether a line takes an incoming call now. */
  private takes(slot: Slot, number: string | null) {
    return this.config.inboundPolicy === "allowlist" && Boolean(number) && this.config.allowFrom.includes(number!) && !this.busy(slot);
  }

  /** Inbound: answer allowlisted callers; leave everyone else ringing (a Twilio line rejects them). */
  private onCall(slot: Slot, msg: any) {
    if (msg.type !== "call.incoming" || this.config.inboundPolicy !== "allowlist") return;
    const number: string | null = msg.call?.number ?? null;
    if (!number || !this.config.allowFrom.includes(number)) {
      this.api.logger.info(`[otacon-voice] line ${slot.config.id}: ignoring incoming call from ${number ?? "an unknown number"} (not allowlisted)`);
      return;
    }
    if (this.busy(slot)) {
      this.api.logger.info(`[otacon-voice] line ${slot.config.id}: ignoring incoming call from ${number}: already on a call`);
      return;
    }
    const known = this.config.contacts.find((c) => c.number === number);
    this.api.logger.info(`[otacon-voice] line ${slot.config.id}: answering ${known?.name ?? number}`);
    const mission = this.newMission(slot, {
      direction: "inbound",
      party: { name: known?.name ?? number, number, role: "primary" },
      contacts: this.config.contacts,
      agentId: this.config.agentId ?? "main",
      requesterSessionKey: this.config.inboundSessionKey,
      inboundCallId: msg.call.id,
    });
    mission.start();
  }

  private onMissionEnd(report: MissionReport) {
    this.recent.unshift(report);
    this.recent.length = Math.min(this.recent.length, 20);
    const sessionKey = report.requesterSessionKey ?? `agent:${report.agentId}:main`;
    const text = formatReport(report);
    this.api.logger.info(
      `[otacon-voice] ${report.missionId} reported to ${sessionKey}: ${report.outcome}; ${report.log.length} log entries`,
    );
    try {
      this.api.runtime.system.enqueueSystemEvent(text, { sessionKey, contextKey: `otacon-voice:${report.missionId}` });
      this.api.runtime.system.requestHeartbeatNow({ sessionKey, agentId: report.agentId, reason: "otacon-voice call ended", source: "other" });
    } catch (err) {
      this.api.logger.warn(`[otacon-voice] could not report call ${report.missionId}: ${String(err)}`);
    }
  }
}
