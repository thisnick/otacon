/**
 * Trace capture for mutating otacon commands. Triggered by the
 * OTACON_TRACE_DIR env var. Each capture writes:
 *   - NNN-<verb>.png      annotated screenshot (or raw bytes for `screenshot`)
 *   - NNN-<verb>.json     sidecar { seq, verb, args, ts }
 *
 * Sequence numbers increment based on the highest existing NNN-*.png in dir.
 */
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import sharp from "sharp";
import type { OtaconClient, A11yNode } from "../../client.js";

export interface CaptureAction {
  verb: string;
  args: string[];
  /** Optional override of which annotation to draw — defaults inferred from verb+args. */
  annotation?: TapAnnotation | SwipeAnnotation | TextAnnotation;
  /** Pre-fetched PNG bytes (e.g., from a `screenshot` call). When omitted, the captureAnnotated will fetch one. */
  png?: Buffer;
}

interface TapAnnotation {
  type: "tap";
  x: number;
  y: number;
}

interface SwipeAnnotation {
  type: "swipe";
  startX: number;
  startY: number;
  endX: number;
  endY: number;
}

interface TextAnnotation {
  type: "text";
  label: string;
}

type Annotation = TapAnnotation | SwipeAnnotation | TextAnnotation;

/**
 * If env.OTACON_TRACE_DIR is set, capture an annotated screenshot for `action`.
 * No-op otherwise. Mutating commands should call this BEFORE the action.
 */
export async function captureAnnotated(
  dir: string | undefined,
  action: CaptureAction,
  client: OtaconClient,
): Promise<void> {
  if (!dir) return;
  await fsp.mkdir(dir, { recursive: true });

  const seq = await nextSeq(dir);
  const seqStr = String(seq).padStart(3, "0");
  const baseName = `${seqStr}-${action.verb}`;

  let png = action.png;
  if (!png) {
    try {
      png = await client.screenshot();
    } catch (e: any) {
      // If screenshot fails, write a sidecar JSON noting the failure but no PNG.
      await fsp.writeFile(
        path.join(dir, `${baseName}.json`),
        JSON.stringify({
          seq,
          verb: action.verb,
          args: action.args,
          ts: new Date().toISOString(),
          screenshot_error: String(e?.message ?? e),
        }, null, 2),
      );
      return;
    }
  }

  // Resolve annotation
  let annotation = action.annotation;
  if (!annotation) {
    annotation = inferAnnotation(action.verb, action.args);
  }

  let outPng: Buffer;
  if (annotation) {
    outPng = await annotateScreenshot(png, annotation);
  } else {
    outPng = png;
  }

  await fsp.writeFile(path.join(dir, `${baseName}.png`), outPng);
  await fsp.writeFile(
    path.join(dir, `${baseName}.json`),
    JSON.stringify({
      seq,
      verb: action.verb,
      args: action.args,
      ts: new Date().toISOString(),
    }, null, 2),
  );
}

async function nextSeq(dir: string): Promise<number> {
  let entries: string[] = [];
  try {
    entries = await fsp.readdir(dir);
  } catch {
    return 1;
  }
  let max = 0;
  for (const name of entries) {
    const m = name.match(/^(\d{3})-/);
    if (m) {
      const n = parseInt(m[1], 10);
      if (n > max) max = n;
    }
  }
  return max + 1;
}

function inferAnnotation(verb: string, args: string[]): Annotation | undefined {
  if (verb === "tap" || verb === "long-tap") {
    if (args.length >= 2) {
      const x = parseInt(args[0]);
      const y = parseInt(args[1]);
      if (!isNaN(x) && !isNaN(y)) return { type: "tap", x, y };
    }
    return { type: "text", label: `${verb}: ${args.join(" ")}` };
  }
  if (verb === "swipe") {
    if (args.length >= 4) {
      return {
        type: "swipe",
        startX: parseInt(args[0]),
        startY: parseInt(args[1]),
        endX: parseInt(args[2]),
        endY: parseInt(args[3]),
      };
    }
  }
  if (
    verb === "key" || verb === "type" || verb === "set-text" || verb === "scroll" ||
    verb === "open" || verb === "apps" || verb === "call" || verb === "clipboard" ||
    verb === "notifications" || verb === "record" || verb === "sms"
  ) {
    return { type: "text", label: `${verb}: ${args.join(" ")}` };
  }
  return undefined;
}

/**
 * Resolve a ref like "e5" to (x, y) by snapshotting the phone and finding
 * the bounds. Returns null if not resolvable. Used by tap/long-tap when
 * args is a single ref.
 */
export async function resolveRefToCoords(
  client: OtaconClient,
  ref: string,
): Promise<{ x: number; y: number } | null> {
  if (!ref.match(/^e\d+$/)) return null;
  try {
    const tree = await client.snapshot("json");
    const found = findRef(tree, ref);
    if (!found) return null;
    const b = (found as any).bounds;
    if (!b || typeof b !== "object") return null;
    const x = Math.floor(((b.left ?? b.x ?? 0) + (b.right ?? (b.x ?? 0) + (b.width ?? 0))) / 2);
    const y = Math.floor(((b.top ?? b.y ?? 0) + (b.bottom ?? (b.y ?? 0) + (b.height ?? 0))) / 2);
    return { x, y };
  } catch {
    return null;
  }
}

function findRef(nodes: A11yNode[] | A11yNode, ref: string): A11yNode | null {
  const stack: any[] = Array.isArray(nodes) ? [...nodes] : [nodes];
  while (stack.length) {
    const n = stack.pop();
    if (!n) continue;
    if ((n as any).ref === ref) return n;
    if (Array.isArray((n as any).children)) stack.push(...(n as any).children);
  }
  return null;
}

async function annotateScreenshot(
  screenshotPng: Buffer,
  annotation: Annotation,
): Promise<Buffer> {
  const metadata = await sharp(screenshotPng).metadata();
  const width = metadata.width ?? 1080;
  const height = metadata.height ?? 2340;

  let svgOverlay: string;

  if (annotation.type === "tap") {
    const { x, y } = annotation;
    const r = 40;
    svgOverlay = `<svg width="${width}" height="${height}">
      <circle cx="${x}" cy="${y}" r="${r}" fill="none" stroke="red" stroke-width="6" opacity="0.8"/>
      <circle cx="${x}" cy="${y}" r="6" fill="red" opacity="0.9"/>
    </svg>`;
  } else if (annotation.type === "swipe") {
    const { startX, startY, endX, endY } = annotation;
    const angle = Math.atan2(endY - startY, endX - startX);
    const headLen = 30;
    const ax = endX - headLen * Math.cos(angle - Math.PI / 6);
    const ay = endY - headLen * Math.sin(angle - Math.PI / 6);
    const bx = endX - headLen * Math.cos(angle + Math.PI / 6);
    const by = endY - headLen * Math.sin(angle + Math.PI / 6);
    svgOverlay = `<svg width="${width}" height="${height}">
      <line x1="${startX}" y1="${startY}" x2="${endX}" y2="${endY}" stroke="red" stroke-width="6" opacity="0.8"/>
      <polygon points="${endX},${endY} ${ax},${ay} ${bx},${by}" fill="red" opacity="0.8"/>
      <circle cx="${startX}" cy="${startY}" r="8" fill="red" opacity="0.9"/>
    </svg>`;
  } else {
    const label = annotation.label.replace(/&/g, "&amp;").replace(/</g, "&lt;");
    svgOverlay = `<svg width="${width}" height="${height}">
      <rect x="10" y="10" width="${Math.min(width - 20, 700)}" height="60" rx="8" fill="black" opacity="0.7"/>
      <text x="20" y="48" font-family="monospace" font-size="24" fill="white">${label}</text>
    </svg>`;
  }

  return sharp(screenshotPng)
    .composite([{ input: Buffer.from(svgOverlay), top: 0, left: 0 }])
    .png()
    .toBuffer();
}
