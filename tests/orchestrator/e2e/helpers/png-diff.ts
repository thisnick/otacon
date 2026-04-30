/**
 * Tiny perceptual-hash helper for trace-screenshot validation.
 *
 * Validates a file is a real PNG via `sharp` metadata, then computes a
 * cheap 8x8-grayscale-mean perceptual hash that's stable enough to flag
 * "two screenshots look identical" without false positives from JPEG-style
 * recompression noise (we have neither — both PNGs come straight from the
 * phone, but the annotated PNG is composited from sharp + SVG so its bytes
 * differ from the source).
 *
 * No external dep beyond `sharp` which the orchestrator already pulls in.
 *
 * The hash is a 64-bit number returned as a hex string. `hammingDistance`
 * counts bit differences; ≤4 is "visually identical", ≥8 is "clearly
 * different". Tap-circle / arrow / box overlays produce diffs ≥10 in our
 * tests.
 */
import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
// `pnpm test:e2e:phase2` runs from `src/orchestrator/`, so Node's
// node_modules walk-up resolves `sharp` from the orchestrator package
// directly. The earlier dynamic-import dance landed on a non-existent
// `sharp/index.jsx` and silently failed every meta read.
import sharpDefault from 'sharp'

/**
 * SHA-256 of the file bytes. Two PNGs that differ by even a single pixel
 * after sharp+SVG compositing will have entirely different SHA-256s —
 * this is the right "did the overlay actually get drawn" check.
 *
 * pHash is too coarse for localized overlays like tap circles (an 8x8
 * grayscale-mean hash quantizes 1080x2340 → 64 pixels, so a 50px ring
 * may not flip a single bit).
 */
export function sha256File(filePath: string): string | null {
  try {
    const buf = fs.readFileSync(filePath)
    return crypto.createHash('sha256').update(buf).digest('hex')
  } catch {
    return null
  }
}

export interface PngMeta {
  ok: boolean
  width: number | null
  height: number | null
  format: string | null
  bytes: number
  error?: string
}

export async function readPngMeta(filePath: string): Promise<PngMeta> {
  let bytes = 0
  try {
    bytes = fs.statSync(filePath).size
  } catch {
    return { ok: false, width: null, height: null, format: null, bytes: 0, error: 'file not found' }
  }
  try {
    const meta = await sharpDefault(filePath).metadata()
    return {
      ok: meta.format === 'png' && (meta.width ?? 0) > 0 && (meta.height ?? 0) > 0,
      width: meta.width ?? null,
      height: meta.height ?? null,
      format: meta.format ?? null,
      bytes,
    }
  } catch (e) {
    return { ok: false, width: null, height: null, format: null, bytes, error: (e as Error).message }
  }
}

/**
 * 8x8 grayscale-mean perceptual hash. Returns a 64-char binary string (or
 * null on read failure). Compare two via hammingDistance.
 */
export async function pHash(filePath: string): Promise<string | null> {
  try {
    const raw = await sharpDefault(filePath).resize(8, 8).grayscale().raw().toBuffer()
    // raw is 64 grayscale bytes (1 byte per pixel)
    const px = Array.from(raw.values())
    const mean = px.reduce((a, b) => a + b, 0) / px.length
    return px.map(p => (p > mean ? '1' : '0')).join('')
  } catch {
    return null
  }
}

export function hammingDistance(a: string, b: string): number {
  if (a.length !== b.length) return Math.max(a.length, b.length)
  let d = 0
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++
  return d
}
