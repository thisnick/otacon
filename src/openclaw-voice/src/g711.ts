// Twilio's call audio is G.711 µ-law at 8 kHz; the rest of the plugin works
// in pcm_s16le at 16 kHz. Codec (ITU-T G.711) and 2x resampling, both
// streaming: each converter keeps the samples it needs across chunks.

const BIAS = 0x84;
const CLIP = 32635;

export function muLawDecode(byte: number): number {
  const u = ~byte & 0xff;
  const t = (((u & 0x0f) << 3) + BIAS) << ((u & 0x70) >> 4);
  return u & 0x80 ? BIAS - t : t - BIAS;
}

export function muLawEncode(sample: number): number {
  let s = Math.max(-32768, Math.min(32767, Math.round(sample)));
  const sign = s < 0 ? 0x80 : 0;
  if (s < 0) s = -s;
  if (s > CLIP) s = CLIP;
  s += BIAS;
  let exponent = 7;
  for (let mask = 0x4000; (s & mask) === 0 && exponent > 0; mask >>= 1) exponent--;
  const mantissa = (s >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

const DECODE = Int16Array.from({ length: 256 }, (_, i) => muLawDecode(i));

// Low-pass at ~3.4 kHz for 16 kHz audio (windowed sinc, 31 taps): keeps
// the 16 -> 8 kHz decimation and the 8 -> 16 kHz interpolation free of
// aliasing and imaging.
const TAPS = (() => {
  const n = 31;
  const fc = 3400 / 16000;
  const h: number[] = [];
  for (let i = 0; i < n; i++) {
    const m = i - (n - 1) / 2;
    const sinc = m === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * m) / (Math.PI * m);
    const hamming = 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (n - 1));
    h.push(sinc * hamming);
  }
  const sum = h.reduce((a, b) => a + b, 0);
  return h.map((x) => x / sum);
})();

class Fir {
  private hist = new Float64Array(TAPS.length);
  private pos = 0;
  push(x: number): number {
    this.hist[this.pos] = x;
    let acc = 0;
    let k = this.pos;
    for (let i = 0; i < TAPS.length; i++) {
      acc += TAPS[i] * this.hist[k];
      k = k === 0 ? TAPS.length - 1 : k - 1;
    }
    this.pos = (this.pos + 1) % TAPS.length;
    return acc;
  }
}

const clamp16 = (x: number) => Math.max(-32768, Math.min(32767, Math.round(x)));

/** Twilio media (µ-law, 8 kHz) -> pcm_s16le 16 kHz. */
export class MuLawToPcm16k {
  private fir = new Fir();
  process(mulaw: Buffer): Buffer {
    const out = Buffer.alloc(mulaw.length * 4);
    for (let i = 0; i < mulaw.length; i++) {
      // Zero-stuff to 16 kHz, then low-pass (gain 2 restores the level).
      out.writeInt16LE(clamp16(2 * this.fir.push(DECODE[mulaw[i]])), i * 4);
      out.writeInt16LE(clamp16(2 * this.fir.push(0)), i * 4 + 2);
    }
    return out;
  }
}

/** pcm_s16le 16 kHz -> Twilio media (µ-law, 8 kHz). */
export class Pcm16kToMuLaw {
  private fir = new Fir();
  private odd = false;
  process(pcm: Buffer): Buffer {
    const n = pcm.length >> 1;
    const out: number[] = [];
    for (let i = 0; i < n; i++) {
      const y = this.fir.push(pcm.readInt16LE(i * 2));
      if (!this.odd) out.push(muLawEncode(y));
      this.odd = !this.odd;
    }
    return Buffer.from(out);
  }
}
