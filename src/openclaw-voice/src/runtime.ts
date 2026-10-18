// The plugin's long-lived side: one otacon control socket for the configured
// phone, the active call mission, inbound call screening, and reporting call
// outcomes back to the agent session that asked for the call.

import { AsyncResource } from "node:async_hooks";
import type { PluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { CallMission, type MissionReport, type Party, type RealtimeSdk, type SpeechDetectorLike } from "./call.js";
import { isE164, type Contact, type OtaconVoiceConfig } from "./config.js";
import { OtaconLink } from "./otacon.js";
import { formatReport } from "./report.js";
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
}

export class OtaconVoiceRuntime {
  readonly link: OtaconLink;
  private mission?: CallMission;
  /**
   * The plugin service's async context, from start(). A call an agent places
   * runs in it, not in the agent turn that called the tool: OpenClaw closes
   * a turn's async work scope when the turn ends, and the call's consults
   * would then fail ("Async work scope is closed").
   */
  private home?: AsyncResource;
  private detector: SpeechDetectorLike | null = null;
  private recent: MissionReport[] = [];

  constructor(
    private api: PluginApi,
    private config: OtaconVoiceConfig,
    private sdk: RealtimeSdk,
    deps: { link?: OtaconLink; createDetector?: () => Promise<SpeechDetectorLike | null> } = {},
  ) {
    this.link = deps.link ?? new OtaconLink({ ...config.otacon, logger: api.logger });
    this.createDetector = deps.createDetector ?? (() => SpeechDetector.create());
  }

  private createDetector: () => Promise<SpeechDetectorLike | null>;

  async start() {
    this.home = new AsyncResource("otacon-voice.call");
    this.detector = await this.createDetector().catch(() => null);
    if (!this.detector) this.api.logger.warn("[otacon-voice] speech detector unavailable (onnxruntime-node); hold detection falls back to the model");
    this.link.on("call", (msg) => this.onCall(msg));
    this.link.start();
  }

  stop() {
    this.mission?.finish("ended_by_agent", "The gateway stopped.");
    this.link.stop();
  }

  get busy() {
    return Boolean(this.mission && !this.mission.status.ended);
  }

  status(missionId?: string) {
    if (this.mission && (!missionId || this.mission.id === missionId)) return this.mission.status;
    const r = this.recent.find((r) => r.missionId === missionId);
    return r ? { missionId: r.missionId, ended: true, outcome: r.outcome, summary: r.summary } : null;
  }

  async startCall(req: StartCall): Promise<{ missionId: string }> {
    if (!this.link.open) throw new Error("not connected to the otacon phone");
    if (this.busy) throw new Error("a call is already in progress on this phone");
    if (!isE164(req.to)) throw new Error("`to` must be an E.164 number like +15551234567");
    const contacts = [...this.config.contacts, ...(req.contacts ?? [])];
    const known = contacts.find((c) => c.number === req.to);
    const party: Party = { name: req.name?.trim() || known?.name || req.to, number: req.to, role: "primary" };
    const mission = this.newMission({
      direction: "outbound",
      party,
      brief: req.brief,
      contacts,
      agentId: req.agentId,
      requesterSessionKey: req.requesterSessionKey,
      sessionKey: req.sessionKey,
    });
    this.home ? this.home.runInAsyncScope(() => mission.start()) : mission.start();
    return { missionId: mission.id };
  }

  endCall(missionId?: string) {
    if (!this.mission || (missionId && this.mission.id !== missionId)) return false;
    this.mission.finish("ended_by_agent", "Ended at the agent's request.");
    return true;
  }

  private newMission(o: {
    direction: "outbound" | "inbound";
    party: Party;
    brief?: string;
    contacts: Contact[];
    agentId: string;
    requesterSessionKey?: string;
    sessionKey?: string;
    inboundCallId?: string;
  }) {
    const mission = new CallMission({
      api: this.api,
      config: this.config,
      link: this.link,
      sdk: this.sdk,
      detector: this.detector,
      ...o,
      onEnd: (report) => this.onMissionEnd(report),
    });
    this.mission = mission;
    return mission;
  }

  /** Inbound: answer allowlisted callers; leave everyone else ringing. */
  private onCall(msg: any) {
    if (msg.type !== "call.incoming" || this.config.inboundPolicy !== "allowlist") return;
    const number: string | null = msg.call?.number ?? null;
    if (!number || !this.config.allowFrom.includes(number)) {
      this.api.logger.info(`[otacon-voice] ignoring incoming call from ${number ?? "an unknown number"} (not allowlisted)`);
      return;
    }
    if (this.busy) {
      this.api.logger.info(`[otacon-voice] ignoring incoming call from ${number}: already on a call`);
      return;
    }
    const known = this.config.contacts.find((c) => c.number === number);
    this.api.logger.info(`[otacon-voice] answering ${known?.name ?? number}`);
    const mission = this.newMission({
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
