// What a listener hears: both sides of a call mixed, at the pace of the
// line. The other party's audio arrives in real time and sets the clock;
// the voice model's audio arrives in bursts ahead of playback, so it queues
// and each line chunk takes the next stretch of it. A barge-in (clear) drops
// what the line never played. pcm_s16le, mono, 16 kHz throughout.

/** Model audio kept for listeners, at most (16 kHz pcm_s16le: 32 bytes per ms) */
const MAX_QUEUED_BYTES = 30_000 * 32;

export class CallMix {
  private queue: Buffer[] = [];
  private queued = 0;

  /** The voice model's audio, as sent to the line. */
  model(pcm: Buffer) {
    if (!pcm.length) return;
    this.queue.push(pcm);
    this.queued += pcm.length;
    while (this.queued > MAX_QUEUED_BYTES && this.queue.length > 1) this.queued -= this.queue.shift()!.length;
  }

  /** The line dropped what it hadn't played (barge-in). */
  clear() {
    this.queue = [];
    this.queued = 0;
  }

  /** A chunk of the other party's audio; returns it mixed with as much model audio. */
  line(pcm: Buffer): Buffer {
    const out = Buffer.alloc(pcm.length - (pcm.length % 2));
    let model = this.take(out.length);
    for (let i = 0; i < out.length; i += 2) {
      const m = i < model.length ? model.readInt16LE(i) : 0;
      out.writeInt16LE(Math.max(-32768, Math.min(32767, pcm.readInt16LE(i) + m)), i);
    }
    return out;
  }

  private take(bytes: number): Buffer {
    const parts: Buffer[] = [];
    let got = 0;
    while (got < bytes && this.queue.length) {
      const head = this.queue[0];
      const n = Math.min(head.length, bytes - got);
      parts.push(head.subarray(0, n));
      got += n;
      if (n === head.length) this.queue.shift();
      else this.queue[0] = head.subarray(n);
    }
    this.queued -= got;
    return Buffer.concat(parts);
  }
}
