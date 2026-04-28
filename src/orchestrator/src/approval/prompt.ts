/**
 * Approval prompt: dual mode — readline on stdin AND file watcher.
 * Races both; whichever fires first wins.
 */
import * as fs from 'node:fs'
import * as fsp from 'node:fs/promises'
import * as path from 'node:path'
import * as readline from 'node:readline'
import {
  parseAnnotation,
  annotateScreenshot,
  saveAndOpenAnnotation,
} from './annotate.js'
import type { OtaconClient } from 'otacon-cli/client'

export interface ApprovalRequest {
  signalId: string
  command: string
  rationale: string
  accountId: string
  phoneId: string
}

export type ApprovalDecision = 'approve' | 'reject' | 'skip'

const APPROVALS_DIR = path.resolve('.orchestrator', 'approvals')

export async function requestApproval(
  req: ApprovalRequest,
  client: OtaconClient | null,
): Promise<ApprovalDecision> {
  // Ensure approvals dir exists
  await fsp.mkdir(APPROVALS_DIR, { recursive: true })

  // Try to capture + annotate screenshot
  let annotatedPath: string | null = null
  if (client) {
    try {
      const png = await client.screenshot()
      const annotation = parseAnnotation(req.command)
      if (annotation) {
        const annotated = await annotateScreenshot(png, annotation)
        annotatedPath = await saveAndOpenAnnotation(annotated)
      } else {
        // Save unannotated screenshot
        annotatedPath = `/tmp/otacon-approval-${Date.now()}.png`
        await fsp.writeFile(annotatedPath, png)
      }
    } catch {
      // Screenshot failed — continue without it
    }
  }

  // Render terminal prompt
  console.log('')
  console.log('┌─ APPROVAL REQUIRED ─────────────────────────────')
  console.log(`│ Account:   ${req.accountId} (${req.phoneId})`)
  console.log(`│ Command:   ${req.command}`)
  console.log(`│ Rationale: ${req.rationale}`)
  if (annotatedPath) {
    console.log(`│ Screenshot: ${annotatedPath}`)
  }
  console.log(`│ Signal ID: ${req.signalId}`)
  console.log('└──────────────────────────────────────────────────')
  console.log('[a]pprove / [r]eject / [s]kip session > ')

  // Race: stdin readline vs file watcher
  return new Promise<ApprovalDecision>((resolve) => {
    let settled = false
    const settle = (decision: ApprovalDecision) => {
      if (settled) return
      settled = true
      cleanup()
      resolve(decision)
    }

    // 1. Stdin readline
    let rl: readline.Interface | null = null
    if (process.stdin.isTTY) {
      rl = readline.createInterface({ input: process.stdin, output: process.stdout })
      rl.on('line', (line) => {
        const l = line.trim().toLowerCase()
        if (l === 'a' || l === 'approve') settle('approve')
        else if (l === 'r' || l === 'reject') settle('reject')
        else if (l === 's' || l === 'skip') settle('skip')
        else console.log('[a]pprove / [r]eject / [s]kip > ')
      })
    }

    // 2. File watcher: watch for .orchestrator/approvals/{signal_id}.json
    const approvalFile = path.join(APPROVALS_DIR, `${req.signalId}.json`)
    let watcher: fs.FSWatcher | null = null
    let pollInterval: ReturnType<typeof setInterval> | null = null

    const checkFile = async () => {
      try {
        const data = await fsp.readFile(approvalFile, 'utf-8')
        const parsed = JSON.parse(data) as { decision: string }
        const d = parsed.decision?.toLowerCase()
        if (d === 'approve' || d === 'reject' || d === 'skip') {
          settle(d as ApprovalDecision)
        }
      } catch {
        // File not yet written or invalid
      }
    }

    // Watch the directory for changes
    try {
      watcher = fs.watch(APPROVALS_DIR, (event, filename) => {
        if (filename === `${req.signalId}.json`) checkFile()
      })
    } catch {
      // If watch fails, rely on polling
    }

    // Also poll every 500ms as a fallback
    pollInterval = setInterval(checkFile, 500)

    // Also check immediately in case file was pre-written
    checkFile()

    function cleanup() {
      rl?.close()
      watcher?.close()
      if (pollInterval) clearInterval(pollInterval)
      // Clean up the approval file
      fsp.rm(approvalFile, { force: true }).catch(() => {})
    }
  })
}
