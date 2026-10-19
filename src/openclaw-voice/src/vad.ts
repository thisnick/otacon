// Speech detection on the call's incoming audio with Silero VAD (v5, MIT),
// run locally with onnxruntime: hold music and silence score near 0, speech
// (live or recorded) near 1. The phone-menu navigator uses it to tell a hold
// (linesound.ts). Nothing here leaves the machine.

import path from "node:path";
import { fileURLToPath } from "node:url";

const WINDOW = 512; // samples at 16 kHz (32 ms)
const CONTEXT = 64; // Silero v5 wants the previous 64 samples prepended

type Ort = typeof import("onnxruntime-node");

let ortPromise: Promise<Ort | null> | undefined;
function loadOrt(): Promise<Ort | null> {
  ortPromise ??= import("onnxruntime-node").then((m: any) => (m.default ?? m) as Ort).catch(() => null);
  return ortPromise;
}

export function modelPath(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "assets", "silero_vad.onnx");
}

/**
 * Feed 16 kHz pcm_s16le; reports a speech probability and the loudness (RMS,
 * full scale 1) per 32 ms window.
 * Windows are processed in order; calls are queued so the model's state
 * stays consistent.
 */
export class SpeechDetector {
  private session: any;
  private ort!: Ort;
  private state!: any;
  private sr!: any;
  private ctx = new Float32Array(CONTEXT);
  private pending = new Float32Array(0);
  private chain: Promise<void> = Promise.resolve();

  static async create(): Promise<SpeechDetector | null> {
    const ort = await loadOrt();
    if (!ort) return null;
    const d = new SpeechDetector();
    d.ort = ort;
    d.session = await ort.InferenceSession.create(modelPath());
    d.reset();
    return d;
  }

  reset() {
    this.state = new this.ort.Tensor("float32", new Float32Array(2 * 128), [2, 1, 128]);
    this.sr = new this.ort.Tensor("int64", BigInt64Array.from([16000n]), []);
    this.ctx = new Float32Array(CONTEXT);
    this.pending = new Float32Array(0);
  }

  /** Queue audio; `onWindow(prob, rms)` is called for each full window. */
  push(pcm16: Buffer, onWindow: (prob: number, rms: number) => void) {
    const n = pcm16.length >> 1;
    const f = new Float32Array(this.pending.length + n);
    f.set(this.pending, 0);
    for (let i = 0; i < n; i++) f[this.pending.length + i] = pcm16.readInt16LE(i * 2) / 32768;
    let off = 0;
    const windows: Float32Array[] = [];
    while (off + WINDOW <= f.length) {
      windows.push(f.subarray(off, off + WINDOW));
      off += WINDOW;
    }
    this.pending = f.slice(off);
    if (!windows.length) return;
    this.chain = this.chain.then(async () => {
      for (const w of windows) {
        let squares = 0;
        for (const x of w) squares += x * x;
        const rms = Math.sqrt(squares / WINDOW);
        const input = new Float32Array(CONTEXT + WINDOW);
        input.set(this.ctx, 0);
        input.set(w, CONTEXT);
        this.ctx = w.slice(WINDOW - CONTEXT);
        try {
          const r = await this.session.run({
            input: new this.ort.Tensor("float32", input, [1, CONTEXT + WINDOW]),
            state: this.state,
            sr: this.sr,
          });
          this.state = r.stateN;
          onWindow(Number(r.output.data[0]), rms);
        } catch {
          onWindow(0, rms);
        }
      }
    });
  }
}
