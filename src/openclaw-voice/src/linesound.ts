// What the line plays, second by second: speech (a person or a recording),
// music, or silence, from the speech detector (vad.ts) and loudness. The
// phone-menu navigator gets it beside its transcript, so it knows the call
// is on hold, and for how long.

export type Sound = "speech" | "music" | "silence";

export interface SoundRun {
  sound: Sound;
  /** Seconds into the call */
  from: number;
  to: number;
}

/** 32 ms detector windows (512 samples at 16 kHz) in a second */
const WINDOWS_PER_SECOND = 31;
/** A second is speech when at least this share of its windows is */
const SPEECH_SHARE = 0.3;
/** Quieter than this (RMS, full scale 1; about -50 dBFS), a second without speech is silence */
const SILENCE_RMS = 0.003;
/** Music or silence this long after the last key press puts the call on hold */
const HOLD_AFTER_SECONDS = 5;
/** A run this short between two of the same sound is folded into them */
const BLIP_SECONDS = 2;
/** Runs the navigator sees */
const RECENT_RUNS = 12;

export class LineSound {
  /** One sound per second, the first at `start` (seconds into the call) */
  private secs: Sound[] = [];
  private start = 0;
  private windows = 0;
  private speechWindows = 0;
  private squares = 0;

  constructor(private nowSeconds: () => number) {}

  /**
   * One detector window: its speech probability and loudness (RMS, full
   * scale 1). Returns the second's sound when the window completes one.
   */
  window(prob: number, rms: number): Sound | undefined {
    this.windows++;
    if (prob > 0.5) this.speechWindows++;
    this.squares += rms * rms;
    if (this.windows < WINDOWS_PER_SECOND) return undefined;
    const sound: Sound =
      this.speechWindows / this.windows >= SPEECH_SHARE
        ? "speech"
        : Math.sqrt(this.squares / this.windows) >= SILENCE_RMS
          ? "music"
          : "silence";
    this.windows = this.speechWindows = this.squares = 0;
    if (!this.secs.length) this.start = Math.max(0, Math.round(this.nowSeconds()) - 1);
    this.secs.push(sound);
    return sound;
  }

  runs(): SoundRun[] {
    const runs: SoundRun[] = [];
    this.secs.forEach((sound, i) => {
      const t = this.start + i;
      const last = runs.at(-1);
      const before = runs.at(-2);
      if (last?.sound === sound) last.to = t + 1;
      else if (last && before?.sound === sound && last.to - last.from < BLIP_SECONDS) {
        runs.pop();
        before.to = t + 1;
      } else runs.push({ sound, from: t, to: t + 1 });
    });
    return runs;
  }

  /** Start of the music or silence playing now, once it has lasted HOLD_AFTER_SECONDS */
  quietSince(): number | undefined {
    const runs = this.runs();
    let from: number | undefined;
    for (let i = runs.length - 1; i >= 0 && runs[i].sound !== "speech"; i--) from = runs[i].from;
    return from !== undefined && runs.at(-1)!.to - from >= HOLD_AFTER_SECONDS ? from : undefined;
  }

  /**
   * For the navigator: what the line plays now and for how long, how long
   * it has been on hold (since the line went to music or silence after the
   * last key press; recorded messages in between count), and the latest runs.
   */
  summary(lastPressAt?: number) {
    const runs = this.runs();
    const now = runs.at(-1);
    if (!now) return undefined;
    const after = lastPressAt ?? -Infinity;
    let quietFrom: number | undefined;
    let holdFrom: number | undefined;
    for (const r of runs) {
      if (r.to <= after || r.sound === "speech") {
        quietFrom = undefined;
        continue;
      }
      quietFrom ??= Math.max(r.from, after);
      if (r.to - quietFrom >= HOLD_AFTER_SECONDS) {
        holdFrom = quietFrom;
        break;
      }
    }
    return {
      now: now.sound,
      for_seconds: now.to - now.from,
      seconds_on_hold: holdFrom === undefined ? 0 : Math.round(now.to - holdFrom),
      recent: runs.slice(-RECENT_RUNS),
    };
  }
}
