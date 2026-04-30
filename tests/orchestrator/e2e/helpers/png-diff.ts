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
import * as fs from 'node:fs'
// Resolve sharp from the orchestrator package (it's not in the repo root deps).
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const ORCH_NM = path.resolve(__dirname, '../../../../src/orchestrator/node_modules')

// Dynamic-import so the helper doesn't choke if sharp is unavailable; we
// surface a clear error at call time instead.
async function loadSharp(): Promise<typeof import('sharp')> {
  // The orchestrator's sharp is reachable from its own node_modules. Try
  // the standard resolution first, fall back to the orchestrator-scoped one.
  try {
    return (await import('sharp')) as unknown as typeof import('sharp')
  } catch {
    return (await import(path.join(ORCH_NM, 'sharp'))) as unknown as typeof import('sharp')
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
    const sharpMod = await loadSharp()
    const sharp = (sharpMod as unknown as { default?: typeof import('sharp') }).default ?? sharpMod
    const meta = await (sharp as unknown as (...a: unknown[]) => { metadata: () => Promise<{ format?: string; width?: number; height?: number }> })(filePath).metadata()
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
    const sharpMod = await loadSharp()
    const sharp = (sharpMod as unknown as { default?: typeof import('sharp') }).default ?? sharpMod
    type SharpFn = (...a: unknown[]) => {
      resize: (w: number, h: number) => unknown
    }
    type SharpStage = {
      grayscale: () => SharpStage
      raw: () => SharpStage
      toBuffer: () => Promise<Buffer>
    }
    const pipeline = (sharp as unknown as SharpFn)(filePath)
    const stage = (pipeline as { resize: (w: number, h: number) => SharpStage }).resize(8, 8)
    const raw = await stage.grayscale().raw().toBuffer()
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
