/**
 * Sharp-based annotation overlays for orchestrator phone-action screenshots.
 *
 * Same approach as the otacon CLI's `_trace.ts` (annotated PNGs into
 * `OTACON_TRACE_DIR`) but lives in the orchestrator so the auto-screenshot
 * wrapper can produce `before/annotated/after` triplets for posterity events.
 *
 * The CLI annotator and this one diverge in one place: this returns a Buffer
 * (the annotated PNG bytes) instead of writing to a file path — the wrapper
 * persists via `BlobStore.putScreenshot(...)`, not directly to disk.
 *
 * Annotations supported:
 *   tap       — red circle at (x, y), small filled dot at center
 *   long-tap  — orange circle (same shape, color delta only)
 *   swipe     — line + arrowhead from (x1,y1) → (x2,y2), filled dot at start
 *   set-text  — black bar at top with truncated label text
 *   key       — black bar at top right with "KEY: <name>"
 *   text      — generic top-bar label fallback
 */
import sharp from 'sharp'
import type { OtaconClient } from 'otacon-cli/client'

export type Annotation =
  | { kind: 'tap'; x: number; y: number; long?: boolean }
  | { kind: 'swipe'; startX: number; startY: number; endX: number; endY: number }
  | { kind: 'text'; label: string }
  | { kind: 'key'; label: string }

/**
 * Compose `annotation` over `screenshotPng`, returning the annotated PNG
 * bytes. If the annotation can't be applied (e.g. unknown kind), returns the
 * input bytes unchanged.
 */
export async function annotateScreenshot(
  screenshotPng: Buffer,
  annotation: Annotation,
): Promise<Buffer> {
  const metadata = await sharp(screenshotPng).metadata()
  const width = metadata.width ?? 1080
  const height = metadata.height ?? 2340

  let svg: string
  if (annotation.kind === 'tap') {
    const { x, y, long } = annotation
    const stroke = long ? 'orange' : 'red'
    const r = 40
    svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <circle cx="${x}" cy="${y}" r="${r}" fill="none" stroke="${stroke}" stroke-width="6" opacity="0.85"/>
      <circle cx="${x}" cy="${y}" r="6" fill="${stroke}" opacity="0.95"/>
    </svg>`
  } else if (annotation.kind === 'swipe') {
    const { startX, startY, endX, endY } = annotation
    const angle = Math.atan2(endY - startY, endX - startX)
    const headLen = 30
    const ax = endX - headLen * Math.cos(angle - Math.PI / 6)
    const ay = endY - headLen * Math.sin(angle - Math.PI / 6)
    const bx = endX - headLen * Math.cos(angle + Math.PI / 6)
    const by = endY - headLen * Math.sin(angle + Math.PI / 6)
    svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <line x1="${startX}" y1="${startY}" x2="${endX}" y2="${endY}" stroke="red" stroke-width="6" opacity="0.85"/>
      <polygon points="${endX},${endY} ${ax},${ay} ${bx},${by}" fill="red" opacity="0.85"/>
      <circle cx="${startX}" cy="${startY}" r="8" fill="red" opacity="0.95"/>
    </svg>`
  } else if (annotation.kind === 'text' || annotation.kind === 'key') {
    const label = escapeSvgText(annotation.label)
    const barWidth = Math.min(width - 20, 800)
    svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <rect x="10" y="10" width="${barWidth}" height="60" rx="8" fill="black" opacity="0.75"/>
      <text x="20" y="48" font-family="monospace" font-size="24" fill="white">${label}</text>
    </svg>`
  } else {
    return screenshotPng
  }

  return sharp(screenshotPng)
    .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
    .png()
    .toBuffer()
}

function escapeSvgText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

// ───────────── annotation inference from otacon args ─────────────

/**
 * Infer the annotation overlay for an otacon mutating verb + args. Returns
 * `null` if the verb has no useful overlay (e.g. `apps launch` — no
 * on-screen target). Tap/long-tap with element refs are resolved against the
 * a11y snapshot to find bounds; the wrapper passes the snapshot in.
 */
export async function inferAnnotation(opts: {
  verb: string
  args: string[]
  client: OtaconClient
  snapshot?: SnapshotForRef | null
}): Promise<Annotation | null> {
  const { verb, args } = opts

  if (verb === 'tap' || verb === 'long-tap') {
    const long = verb === 'long-tap'
    if (args.length >= 2) {
      const x = parseInt(args[0], 10)
      const y = parseInt(args[1], 10)
      if (Number.isFinite(x) && Number.isFinite(y)) return { kind: 'tap', x, y, long }
    }
    if (args.length >= 1 && /^e\d+$/.test(args[0])) {
      const coords = await resolveRefToCoords(opts.client, args[0], opts.snapshot)
      if (coords) return { kind: 'tap', x: coords.x, y: coords.y, long }
    }
    return { kind: 'text', label: `${verb}: ${args.join(' ')}` }
  }

  if (verb === 'swipe') {
    if (args.length >= 4) {
      const startX = parseInt(args[0], 10)
      const startY = parseInt(args[1], 10)
      const endX = parseInt(args[2], 10)
      const endY = parseInt(args[3], 10)
      if ([startX, startY, endX, endY].every(Number.isFinite)) {
        return { kind: 'swipe', startX, startY, endX, endY }
      }
    }
    return { kind: 'text', label: `swipe: ${args.join(' ')}` }
  }

  if (verb === 'set-text' || verb === 'type') {
    const ref = args[0] ?? ''
    const text = args.slice(1).join(' ')
    return { kind: 'text', label: `${verb} ${ref}: ${truncate(text, 50)}` }
  }

  if (verb === 'key') {
    return { kind: 'key', label: `KEY: ${args.join(' ')}` }
  }

  if (verb === 'scroll' || verb === 'open' || verb === 'apps' || verb === 'call' ||
      verb === 'sms' || verb === 'clipboard' || verb === 'notifications' ||
      verb === 'record' || verb === 'contacts') {
    return { kind: 'text', label: `${verb}: ${args.join(' ')}` }
  }

  return null
}

interface RefBounds {
  ref?: string
  bounds?: { left?: number; right?: number; top?: number; bottom?: number; x?: number; y?: number; width?: number; height?: number }
  children?: RefBounds[]
}
type SnapshotForRef = RefBounds[]

async function resolveRefToCoords(
  client: OtaconClient,
  ref: string,
  snapshot?: SnapshotForRef | null,
): Promise<{ x: number; y: number } | null> {
  let tree = snapshot ?? null
  if (!tree) {
    try { tree = (await client.snapshot('json')) as SnapshotForRef } catch { return null }
  }
  const node = findRef(tree, ref)
  if (!node?.bounds) return null
  const b = node.bounds
  const left = b.left ?? b.x ?? 0
  const right = b.right ?? (b.x ?? 0) + (b.width ?? 0)
  const top = b.top ?? b.y ?? 0
  const bottom = b.bottom ?? (b.y ?? 0) + (b.height ?? 0)
  return {
    x: Math.floor((left + right) / 2),
    y: Math.floor((top + bottom) / 2),
  }
}

function findRef(nodes: SnapshotForRef | RefBounds | null, ref: string): RefBounds | null {
  if (!nodes) return null
  const stack: RefBounds[] = Array.isArray(nodes) ? [...nodes] : [nodes]
  while (stack.length) {
    const n = stack.pop()
    if (!n) continue
    if (n.ref === ref) return n
    if (Array.isArray(n.children)) stack.push(...n.children)
  }
  return null
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max) + '…'
}
