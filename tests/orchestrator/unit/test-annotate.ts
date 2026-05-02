/**
 * Unit tests for `src/orchestrator/src/sandbox/annotate.ts`.
 *
 * Two question categories:
 *
 *   1. **inferAnnotation** — given a verb + args + (real-shape) snapshot,
 *      do we produce the right `Annotation` (right kind, right bounds /
 *      coords, right direction)?
 *
 *   2. **annotateScreenshot** — does the SVG actually render onto the
 *      input PNG? We construct a synthetic plain-white PNG, annotate it,
 *      and verify the output bytes differ AND have red pixels in the
 *      target region. This catches the class of bug where the SVG
 *      compositing path silently returns the input unchanged or draws
 *      offscreen.
 *
 * Real bounds shape (from host's snapshot.rs): `{x1, y1, x2, y2}` —
 * top-left + bottom-right corners. Real ref id field: `ref_id`.
 *
 * Run: pnpm --filter orchestrator exec tsx ../../tests/orchestrator/unit/test-annotate.ts
 */
import sharp from 'sharp'
import { annotateScreenshot, inferAnnotation, type Annotation } from '../../../src/orchestrator/src/sandbox/annotate.js'
import type { OtaconClient } from '../../../src/cli/src/client.js'

let passed = 0
let failed = 0

function assert(cond: boolean, msg: string) {
  if (cond) { console.log(`  PASS  ${msg}`); passed++ }
  else      { console.log(`  FAIL  ${msg}`); failed++ }
}

// ─────────── synthetic PNG (white background) ─────────────────

async function makeWhitePng(width: number, height: number): Promise<Buffer> {
  return await sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 255, g: 255, b: 255 },
    },
  }).png().toBuffer()
}

interface RawPixel {
  r: number
  g: number
  b: number
  a: number
}

async function getPixel(png: Buffer, x: number, y: number): Promise<RawPixel> {
  const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true })
  const channels = info.channels
  const idx = (y * info.width + x) * channels
  return {
    r: data[idx],
    g: data[idx + 1],
    b: data[idx + 2],
    a: channels >= 4 ? data[idx + 3] : 255,
  }
}

function isReddish(p: RawPixel): boolean {
  return p.r > 150 && p.g < 100 && p.b < 100
}

function isOrangish(p: RawPixel): boolean {
  return p.r > 200 && p.g > 100 && p.g < 180 && p.b < 80
}

function isWhitish(p: RawPixel): boolean {
  return p.r > 240 && p.g > 240 && p.b > 240
}

// ─────────── stub OtaconClient (only `snapshot` used) ─────────

const stubClient: OtaconClient = {
  baseUrl: 'http://stub',
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async snapshot(_format: any): Promise<any> {
    return [] as never
  },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} as any

// ─────────── snapshot fixture (real host shape) ───────────────

const snapshot = [
  {
    class: 'FrameLayout',
    bounds: { x1: 0, y1: 0, x2: 1080, y2: 2400 },
    children: [
      {
        class: 'androidx.recyclerview.widget.RecyclerView',
        ref_id: 'e281',
        bounds: { x1: 0, y1: 400, x2: 1080, y2: 2200 },
        children: [],
      },
      {
        class: 'EditText',
        ref_id: 'e5',
        bounds: { x1: 60, y1: 100, x2: 1020, y2: 200 },
        children: [],
      },
    ],
  },
]

async function main() {
  console.log('annotate.ts')

  // ── inferAnnotation ───────────────────────────────────────

  // tap with coords
  {
    const a = await inferAnnotation({ verb: 'tap', args: ['540', '1200'], client: stubClient, snapshot })
    assert(!!a && a.kind === 'tap-coords' && a.x === 540 && a.y === 1200, 'tap with coords → tap-coords annotation')
  }

  // tap with ref → resolves to bounds (host shape)
  {
    const a = await inferAnnotation({ verb: 'tap', args: ['e5'], client: stubClient, snapshot })
    if (a?.kind === 'tap') {
      assert(a.bounds.x1 === 60 && a.bounds.y1 === 100 && a.bounds.x2 === 1020 && a.bounds.y2 === 200, 'tap e5 resolves to {x1:60,y1:100,x2:1020,y2:200}')
    } else {
      assert(false, `tap e5 → expected kind=tap, got ${a?.kind}`)
    }
  }

  // long-tap with ref → orange flag
  {
    const a = await inferAnnotation({ verb: 'long-tap', args: ['e5'], client: stubClient, snapshot })
    assert(a?.kind === 'tap' && a.long === true, 'long-tap e5 → tap annotation with long=true')
  }

  // unknown ref → falls through to text
  {
    const a = await inferAnnotation({ verb: 'tap', args: ['e9999'], client: stubClient, snapshot })
    assert(a?.kind === 'text', 'tap on unknown ref falls through to text')
  }

  // swipe with coords
  {
    const a = await inferAnnotation({ verb: 'swipe', args: ['100', '200', '300', '400'], client: stubClient, snapshot })
    assert(
      a?.kind === 'swipe' && a.startX === 100 && a.startY === 200 && a.endX === 300 && a.endY === 400,
      'swipe with coords → swipe annotation',
    )
  }

  // set-text with ref → box annotation around bounds
  {
    const a = await inferAnnotation({ verb: 'set-text', args: ['e5', 'hello world'], client: stubClient, snapshot })
    if (a?.kind === 'box') {
      assert(
        a.bounds.x1 === 60 && a.bounds.y1 === 100 && a.bounds.x2 === 1020 && a.bounds.y2 === 200,
        'set-text e5 → box annotation around the EditText bounds',
      )
      assert(a.label.includes('hello world'), 'set-text label includes truncated text')
    } else {
      assert(false, `set-text e5 → expected kind=box, got ${a?.kind}`)
    }
  }

  // scroll with ref + direction down → swipe annotation (gesture is upward)
  {
    const a = await inferAnnotation({ verb: 'scroll', args: ['e281', '--direction', 'down'], client: stubClient, snapshot })
    if (a?.kind === 'swipe') {
      // Bounds are y1=400, y2=2200 → padding 270 → high=670, low=1930.
      // direction=down means swipe goes from low (bottom) to high (top).
      assert(a.startY > a.endY, 'scroll-down → swipe goes upward (startY > endY)')
      assert(a.startX === a.endX, 'scroll → vertical swipe (startX === endX)')
      assert(a.startX === 540, 'scroll → swipe centered horizontally on bounds (cx=540)')
    } else {
      assert(false, `scroll e281 → expected kind=swipe, got ${a?.kind}`)
    }
  }

  // scroll --up → swipe goes downward
  {
    const a = await inferAnnotation({ verb: 'scroll', args: ['e281', '--up'], client: stubClient, snapshot })
    if (a?.kind === 'swipe') {
      assert(a.startY < a.endY, 'scroll-up → swipe goes downward (startY < endY)')
    } else {
      assert(false, `scroll --up → expected kind=swipe, got ${a?.kind}`)
    }
  }

  // key — text-only label, no on-screen overlay
  {
    const a = await inferAnnotation({ verb: 'key', args: ['HOME'], client: stubClient, snapshot })
    assert(a?.kind === 'key' && a.label.includes('HOME'), 'key HOME → key annotation')
  }

  // ── annotateScreenshot — actually renders SVG over PNG ─────

  const W = 400
  const H = 800
  const whitePng = await makeWhitePng(W, H)

  // tap-coords renders a red ring at the tap point
  {
    const out = await annotateScreenshot(whitePng, { kind: 'tap-coords', x: 200, y: 400, long: false })
    assert(!whitePng.equals(out), 'annotateScreenshot tap-coords differs from input')
    const center = await getPixel(out, 200, 400)
    assert(isReddish(center), `tap-coords renders red dot at center (got rgb(${center.r},${center.g},${center.b}))`)
    const corner = await getPixel(out, 5, 5)
    assert(isWhitish(corner), 'tap-coords leaves the corner untouched (white)')
  }

  // tap (with bounds) renders a ring around the bounds
  {
    const a: Annotation = { kind: 'tap', bounds: { x1: 100, y1: 100, x2: 300, y2: 300 }, long: false }
    const out = await annotateScreenshot(whitePng, a)
    assert(!whitePng.equals(out), 'annotateScreenshot tap-bounds differs from input')
    const center = await getPixel(out, 200, 200) // dot
    assert(isReddish(center), `tap-bounds renders red dot at bounds center (got rgb(${center.r},${center.g},${center.b}))`)
  }

  // long-tap is orange
  {
    const a: Annotation = { kind: 'tap', bounds: { x1: 100, y1: 100, x2: 300, y2: 300 }, long: true }
    const out = await annotateScreenshot(whitePng, a)
    const center = await getPixel(out, 200, 200)
    assert(isOrangish(center), `long-tap renders orange dot at center (got rgb(${center.r},${center.g},${center.b}))`)
  }

  // swipe renders a line + dot at start
  {
    const a: Annotation = { kind: 'swipe', startX: 100, startY: 100, endX: 300, endY: 300 }
    const out = await annotateScreenshot(whitePng, a)
    assert(!whitePng.equals(out), 'annotateScreenshot swipe differs from input')
    const start = await getPixel(out, 100, 100)
    assert(isReddish(start), `swipe renders red dot at start point (got rgb(${start.r},${start.g},${start.b}))`)
    const mid = await getPixel(out, 200, 200)
    assert(isReddish(mid), `swipe renders line through midpoint (got rgb(${mid.r},${mid.g},${mid.b}))`)
  }

  // box renders a rectangle outline + label
  {
    const a: Annotation = { kind: 'box', bounds: { x1: 50, y1: 200, x2: 350, y2: 280 }, label: 'set-text: hello' }
    const out = await annotateScreenshot(whitePng, a)
    assert(!whitePng.equals(out), 'annotateScreenshot box differs from input')
    const onTopEdge = await getPixel(out, 200, 200)
    assert(isReddish(onTopEdge), `box renders red on top edge (got rgb(${onTopEdge.r},${onTopEdge.g},${onTopEdge.b}))`)
  }

  // text label renders only the top bar (no on-screen overlay)
  {
    const a: Annotation = { kind: 'text', label: 'open: https://x.com' }
    const out = await annotateScreenshot(whitePng, a)
    assert(!whitePng.equals(out), 'annotateScreenshot text differs from input')
    const topBar = await getPixel(out, 50, 30)
    assert(topBar.r < 100 && topBar.g < 100 && topBar.b < 100, `text renders black top bar (got rgb(${topBar.r},${topBar.g},${topBar.b}))`)
    const mid = await getPixel(out, 200, 400)
    assert(isWhitish(mid), `text leaves mid-screen untouched (got rgb(${mid.r},${mid.g},${mid.b}))`)
  }

  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch(e => {
  console.error(e)
  process.exit(1)
})
