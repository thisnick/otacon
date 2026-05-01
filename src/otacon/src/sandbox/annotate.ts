/**
 * Sharp-based annotation overlays for orchestrator phone-action screenshots.
 *
 * Same approach as the otacon CLI's `_trace.ts` (annotated PNGs into
 * `OTACON_TRACE_DIR`) but lives in the orchestrator so the auto-screenshot
 * wrapper can produce `before/annotated/after` triplets for posterity events.
 *
 * Annotations supported:
 *   tap       — red ring around the element bounds, dot at the center
 *   long-tap  — orange ring + dot (same shape, color delta only)
 *   swipe     — red line + arrowhead from (x1,y1) → (x2,y2), filled dot at start
 *   box       — rectangle around the element bounds + label at top-left corner
 *               (used for set-text / type — shows where text is going)
 *   key       — black bar at top-right with "KEY: <name>" (no on-screen target)
 *   text      — black bar at top with a label (fallback for verbs without a
 *               geometric target — open uri, apps launch, etc.)
 *
 * Element targets (tap / set-text / type / scroll <ref>) resolve their
 * bounds against the a11y snapshot the wrapper passed in. The host's
 * `A11yNode.bounds` is `{x1, y1, x2, y2}` (top-left + bottom-right corners).
 */
import sharp from 'sharp'
import type { OtaconClient } from 'otacon-cli/client'

export interface RefBounds {
  x1: number
  y1: number
  x2: number
  y2: number
}

export type Annotation =
  | { kind: 'tap'; bounds: RefBounds; long?: boolean }
  | { kind: 'tap-coords'; x: number; y: number; long?: boolean }
  | { kind: 'swipe'; startX: number; startY: number; endX: number; endY: number }
  | { kind: 'box'; bounds: RefBounds; label: string }
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
  const height = metadata.height ?? 2400

  const svg = renderSvg(width, height, annotation)
  if (!svg) return screenshotPng

  return sharp(screenshotPng)
    .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
    .png()
    .toBuffer()
}

function renderSvg(width: number, height: number, a: Annotation): string | null {
  if (a.kind === 'tap') {
    const cx = (a.bounds.x1 + a.bounds.x2) / 2
    const cy = (a.bounds.y1 + a.bounds.y2) / 2
    // Ring sized to half the smaller dimension, clamped to a reasonable range.
    const w = Math.abs(a.bounds.x2 - a.bounds.x1)
    const h = Math.abs(a.bounds.y2 - a.bounds.y1)
    const r = Math.max(50, Math.min(160, Math.min(w, h) / 2))
    const stroke = a.long ? '#ff8800' : '#ff0000'
    return svg(width, height, [
      `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${stroke}" stroke-width="8" opacity="0.9"/>`,
      `<circle cx="${cx}" cy="${cy}" r="10" fill="${stroke}" opacity="1"/>`,
    ])
  }
  if (a.kind === 'tap-coords') {
    const stroke = a.long ? '#ff8800' : '#ff0000'
    return svg(width, height, [
      `<circle cx="${a.x}" cy="${a.y}" r="60" fill="none" stroke="${stroke}" stroke-width="8" opacity="0.9"/>`,
      `<circle cx="${a.x}" cy="${a.y}" r="10" fill="${stroke}" opacity="1"/>`,
    ])
  }
  if (a.kind === 'swipe') {
    const { startX, startY, endX, endY } = a
    const angle = Math.atan2(endY - startY, endX - startX)
    const headLen = 60
    const ax = endX - headLen * Math.cos(angle - Math.PI / 6)
    const ay = endY - headLen * Math.sin(angle - Math.PI / 6)
    const bx = endX - headLen * Math.cos(angle + Math.PI / 6)
    const by = endY - headLen * Math.sin(angle + Math.PI / 6)
    return svg(width, height, [
      `<line x1="${startX}" y1="${startY}" x2="${endX}" y2="${endY}" stroke="#ff0000" stroke-width="10" opacity="0.9" stroke-linecap="round"/>`,
      `<polygon points="${endX},${endY} ${ax},${ay} ${bx},${by}" fill="#ff0000" opacity="0.95"/>`,
      `<circle cx="${startX}" cy="${startY}" r="14" fill="#ff0000" opacity="1"/>`,
    ])
  }
  if (a.kind === 'box') {
    const x = Math.min(a.bounds.x1, a.bounds.x2)
    const y = Math.min(a.bounds.y1, a.bounds.y2)
    const w = Math.abs(a.bounds.x2 - a.bounds.x1)
    const h = Math.abs(a.bounds.y2 - a.bounds.y1)
    const label = escapeSvgText(a.label)
    // Label sits just above the box if there's room, else inside the box at top.
    const labelY = y > 50 ? y - 14 : y + 36
    const labelBg = y > 50 ? `<rect x="${x - 4}" y="${y - 50}" width="${Math.min(width - x + 4, 700)}" height="46" rx="6" fill="black" opacity="0.85"/>` : ''
    return svg(width, height, [
      `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="none" stroke="#ff0000" stroke-width="8" opacity="0.9"/>`,
      labelBg,
      `<text x="${x + 4}" y="${labelY}" font-family="monospace" font-size="32" fill="${y > 50 ? 'white' : '#ff0000'}" font-weight="bold">${label}</text>`,
    ])
  }
  if (a.kind === 'text' || a.kind === 'key') {
    const label = escapeSvgText(a.label)
    const barWidth = Math.min(width - 20, 1000)
    return svg(width, height, [
      `<rect x="10" y="10" width="${barWidth}" height="60" rx="8" fill="black" opacity="0.85"/>`,
      `<text x="20" y="52" font-family="monospace" font-size="28" fill="white">${label}</text>`,
    ])
  }
  return null
}

function svg(width: number, height: number, parts: string[]): string {
  return `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">${parts.join('')}</svg>`
}

function escapeSvgText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

// ───────────── annotation inference from otacon args ─────────────

/**
 * Infer the annotation overlay for an otacon mutating verb + args. Returns
 * `null` if the verb has no useful overlay. Element refs are resolved against
 * the a11y snapshot so refs (`e5`) become real bounds even though the agent
 * never saw coordinates.
 */
export async function inferAnnotation(opts: {
  verb: string
  args: string[]
  client: OtaconClient
  snapshot?: A11yTreeRoot | null
}): Promise<Annotation | null> {
  const { verb, args, client, snapshot } = opts

  if (verb === 'tap' || verb === 'long-tap') {
    const long = verb === 'long-tap'
    if (args.length >= 2) {
      const x = parseInt(args[0], 10)
      const y = parseInt(args[1], 10)
      if (Number.isFinite(x) && Number.isFinite(y)) {
        return { kind: 'tap-coords', x, y, long }
      }
    }
    if (args.length >= 1 && /^e\d+$/.test(args[0])) {
      const bounds = await resolveRefToBounds(client, args[0], snapshot)
      if (bounds) return { kind: 'tap', bounds, long }
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
    if (/^e\d+$/.test(ref)) {
      const bounds = await resolveRefToBounds(client, ref, snapshot)
      if (bounds) {
        return {
          kind: 'box',
          bounds,
          label: `${verb}: ${truncate(text, 40)}`,
        }
      }
    }
    return { kind: 'text', label: `${verb} ${ref}: ${truncate(text, 50)}` }
  }

  if (verb === 'scroll') {
    // Parse `--direction up|down|--up` and the optional ref.
    let ref: string | undefined
    let direction: 'up' | 'down' = 'down'
    for (let i = 0; i < args.length; i++) {
      const a = args[i]
      if (a === '--direction' && args[i + 1]) { direction = args[++i] as 'up' | 'down' }
      else if (a === '--up') direction = 'up'
      else if (a === '--down') direction = 'down'
      else if (!ref) ref = a
    }
    if (ref && /^e\d+$/.test(ref)) {
      const bounds = await resolveRefToBounds(client, ref, snapshot)
      if (bounds) {
        // Visualize the gesture itself: scroll-down (see content below) means
        // a swipe-up gesture on screen — finger drags from bottom toward top.
        // scroll-up reverses. Center horizontally; use 70% of the bounds
        // height for the swipe length.
        const cx = Math.floor((bounds.x1 + bounds.x2) / 2)
        const top = Math.min(bounds.y1, bounds.y2)
        const bottom = Math.max(bounds.y1, bounds.y2)
        const h = bottom - top
        const padding = Math.floor(h * 0.15)
        const high = top + padding
        const low = bottom - padding
        const startY = direction === 'down' ? low : high
        const endY = direction === 'down' ? high : low
        return { kind: 'swipe', startX: cx, startY, endX: cx, endY }
      }
    }
    return { kind: 'text', label: `scroll: ${args.join(' ')}` }
  }

  if (verb === 'key') {
    return { kind: 'key', label: `KEY: ${args.join(' ')}` }
  }

  if (verb === 'open' || verb === 'apps' || verb === 'call' ||
      verb === 'sms' || verb === 'clipboard' || verb === 'notifications' ||
      verb === 'record' || verb === 'contacts') {
    return { kind: 'text', label: `${verb}: ${args.join(' ')}` }
  }

  return null
}

// ────────────── ref → bounds resolution ──────────────

interface A11yNodeRef {
  /** Host's snake-case field — what the JSON wire format actually carries. */
  ref_id?: string
  /** Defensive fallback if a different snapshot shape sneaks in. */
  ref?: string
  bounds?: HostBounds | LegacyBounds | null
  children?: A11yNodeRef[]
}

interface HostBounds {
  x1: number
  y1: number
  x2: number
  y2: number
}

/**
 * Older or alternative bounds shapes — defensive fallback. Real prod data
 * uses `HostBounds` ({x1,y1,x2,y2}) per src/server/src/api/snapshot.rs.
 */
interface LegacyBounds {
  left?: number
  right?: number
  top?: number
  bottom?: number
  x?: number
  y?: number
  width?: number
  height?: number
}

type A11yTreeRoot = A11yNodeRef[] | A11yNodeRef

async function resolveRefToBounds(
  client: OtaconClient,
  ref: string,
  snapshot?: A11yTreeRoot | null,
): Promise<RefBounds | null> {
  let tree: A11yTreeRoot | null = snapshot ?? null
  if (!tree) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      tree = (await client.snapshot('json')) as any
    } catch { return null }
  }
  if (!tree) return null
  const node = findRef(tree, ref)
  if (!node?.bounds) return null
  return normalizeBounds(node.bounds)
}

function normalizeBounds(b: HostBounds | LegacyBounds): RefBounds | null {
  // Real shape from host: {x1, y1, x2, y2}. Recognize first.
  const asHost = b as HostBounds
  if (
    Number.isFinite(asHost.x1) && Number.isFinite(asHost.x2) &&
    Number.isFinite(asHost.y1) && Number.isFinite(asHost.y2)
  ) {
    return { x1: asHost.x1, y1: asHost.y1, x2: asHost.x2, y2: asHost.y2 }
  }
  const lg = b as LegacyBounds
  const x1 = lg.left ?? lg.x
  const y1 = lg.top ?? lg.y
  const x2 = lg.right ?? ((lg.x ?? 0) + (lg.width ?? 0))
  const y2 = lg.bottom ?? ((lg.y ?? 0) + (lg.height ?? 0))
  if ([x1, y1, x2, y2].every(v => Number.isFinite(v))) {
    return { x1: x1 as number, y1: y1 as number, x2: x2 as number, y2: y2 as number }
  }
  return null
}

function findRef(nodes: A11yTreeRoot | null, ref: string): A11yNodeRef | null {
  if (!nodes) return null
  const stack: A11yNodeRef[] = Array.isArray(nodes) ? [...nodes] : [nodes]
  while (stack.length) {
    const n = stack.pop()
    if (!n) continue
    // Host JSON field is `ref_id`; some legacy callers used `ref`. Match
    // either so a future schema change doesn't break us silently again.
    if (n.ref_id === ref || n.ref === ref) return n
    if (Array.isArray(n.children)) stack.push(...n.children)
  }
  return null
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max) + '…'
}
