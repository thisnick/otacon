/**
 * Screenshot annotation for approval prompts.
 * Overlays tap circles or swipe arrows on a screenshot PNG using sharp.
 */
import sharp from 'sharp'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { exec } from 'node:child_process'

interface TapAnnotation {
  type: 'tap'
  x: number
  y: number
}

interface SwipeAnnotation {
  type: 'swipe'
  startX: number
  startY: number
  endX: number
  endY: number
}

interface TextAnnotation {
  type: 'text'
  label: string
}

export type Annotation = TapAnnotation | SwipeAnnotation | TextAnnotation

export function parseAnnotation(command: string): Annotation | null {
  const trimmed = command.trim()
  const match = trimmed.match(/^(?:otacon\s+)?(\S+)\s*(.*)$/)
  if (!match) return null
  const [, verb, argsStr] = match
  const args = argsStr.split(/\s+/).filter(Boolean)

  if (verb === 'tap' || verb === 'long-tap') {
    if (args.length >= 2) {
      const x = parseInt(args[0])
      const y = parseInt(args[1])
      if (!isNaN(x) && !isNaN(y)) return { type: 'tap', x, y }
    }
    // Ref-based tap — can't annotate coordinates without snapshot resolution
    return null
  }

  if (verb === 'swipe') {
    if (args.length >= 4) {
      return {
        type: 'swipe',
        startX: parseInt(args[0]),
        startY: parseInt(args[1]),
        endX: parseInt(args[2]),
        endY: parseInt(args[3]),
      }
    }
  }

  if (verb === 'key' || verb === 'type' || verb === 'set-text') {
    return { type: 'text', label: `${verb}: ${argsStr}` }
  }

  return null
}

export async function annotateScreenshot(
  screenshotPng: Buffer,
  annotation: Annotation,
): Promise<Buffer> {
  const metadata = await sharp(screenshotPng).metadata()
  const width = metadata.width ?? 1080
  const height = metadata.height ?? 2340

  let svgOverlay: string

  if (annotation.type === 'tap') {
    const { x, y } = annotation
    const r = 40
    svgOverlay = `<svg width="${width}" height="${height}">
      <circle cx="${x}" cy="${y}" r="${r}" fill="none" stroke="red" stroke-width="6" opacity="0.8"/>
      <circle cx="${x}" cy="${y}" r="6" fill="red" opacity="0.9"/>
    </svg>`
  } else if (annotation.type === 'swipe') {
    const { startX, startY, endX, endY } = annotation
    // Arrow with arrowhead
    const angle = Math.atan2(endY - startY, endX - startX)
    const headLen = 30
    const ax = endX - headLen * Math.cos(angle - Math.PI / 6)
    const ay = endY - headLen * Math.sin(angle - Math.PI / 6)
    const bx = endX - headLen * Math.cos(angle + Math.PI / 6)
    const by = endY - headLen * Math.sin(angle + Math.PI / 6)
    svgOverlay = `<svg width="${width}" height="${height}">
      <line x1="${startX}" y1="${startY}" x2="${endX}" y2="${endY}" stroke="red" stroke-width="6" opacity="0.8"/>
      <polygon points="${endX},${endY} ${ax},${ay} ${bx},${by}" fill="red" opacity="0.8"/>
      <circle cx="${startX}" cy="${startY}" r="8" fill="red" opacity="0.9"/>
    </svg>`
  } else {
    const label = annotation.label.replace(/&/g, '&amp;').replace(/</g, '&lt;')
    svgOverlay = `<svg width="${width}" height="${height}">
      <rect x="10" y="10" width="${Math.min(width - 20, 600)}" height="60" rx="8" fill="black" opacity="0.7"/>
      <text x="20" y="48" font-family="monospace" font-size="24" fill="white">${label}</text>
    </svg>`
  }

  return sharp(screenshotPng)
    .composite([{ input: Buffer.from(svgOverlay), top: 0, left: 0 }])
    .png()
    .toBuffer()
}

export async function saveAndOpenAnnotation(annotatedPng: Buffer): Promise<string> {
  const filename = `otacon-approval-${Date.now()}.png`
  const filepath = path.join('/tmp', filename)
  await fs.writeFile(filepath, annotatedPng)

  // Open on macOS
  if (process.platform === 'darwin') {
    exec(`open "${filepath}"`)
  }

  return filepath
}
