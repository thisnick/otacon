/**
 * Builds a just-bash sandbox with the `otacon` defineCommand wrapping OtaconClient.
 * The otacon command has 1:1 signature with the actual CLI.
 */
import { Bash, defineCommand, MountableFs, InMemoryFs } from 'just-bash'
import { BlobBackedFs } from '../storage/blob-fs.js'
import type { BlobStore } from '../storage/blob.js'
import type { OtaconClient } from 'otacon-cli/client'

/** Which otacon subcommands mutate phone state (require approval). */
const MUTATING_VERBS = new Set([
  'tap', 'swipe', 'key', 'type', 'scroll', 'set-text', 'long-tap',
  'open', 'call', 'sms',
])

export function isMutating(command: string): boolean {
  const trimmed = command.trim()
  // Match "otacon <verb>" or just "<verb>" if already inside the otacon command
  const match = trimmed.match(/^(?:otacon\s+)?(\S+)/)
  if (!match) return false
  return MUTATING_VERBS.has(match[1])
}

interface SandboxOptions {
  client: OtaconClient
  blobStore: BlobStore
  accountId: string
}

export function buildSandbox(opts: SandboxOptions): Bash {
  const { client, blobStore, accountId } = opts

  const otaconCmd = defineCommand('otacon', async (args) => {
    const [verb, ...rest] = args
    if (!verb) {
      return {
        stdout: '',
        stderr: 'Usage: otacon <command> [args...]\n\nCommands: screenshot, snapshot, info, tap, swipe, key, type, set-text, scroll, open, apps, sms, notifications, clipboard, contacts, call, record\n',
        exitCode: 1,
      }
    }

    try {
      const result = await dispatchOtacon(client, verb, rest)
      return { stdout: result + '\n', stderr: '', exitCode: 0 }
    } catch (e: any) {
      return { stdout: '', stderr: `otacon ${verb}: ${e.message}\n`, exitCode: 1 }
    }
  })

  // Set up blob-backed FS for workspace and config
  const workspaceFs = new BlobBackedFs(blobStore, `accounts/${accountId}/workspace`)
  const configFs = new BlobBackedFs(blobStore, `accounts/${accountId}/config`)

  const fs = new MountableFs({
    base: new InMemoryFs(),
    mounts: [
      { mountPoint: '/workspace', filesystem: workspaceFs },
      { mountPoint: '/config', filesystem: configFs },
    ],
  })

  return new Bash({
    customCommands: [otaconCmd],
    fs,
    cwd: '/workspace',
  })
}

/**
 * Dispatch an otacon CLI verb to the OtaconClient.
 * Returns the string output for stdout.
 */
async function dispatchOtacon(client: OtaconClient, verb: string, args: string[]): Promise<string> {
  switch (verb) {
    case 'screenshot': {
      const buf = await client.screenshot()
      return `[screenshot captured: ${buf.length} bytes]`
    }

    case 'snapshot': {
      if (args.includes('--json')) {
        const result = await client.snapshot('json')
        return JSON.stringify(result, null, 2)
      }
      return await client.snapshot('text')
    }

    case 'info': {
      const info = await client.info()
      if (args.includes('--json')) return JSON.stringify(info, null, 2)
      return Object.entries(info)
        .map(([k, v]) => `${k.padEnd(20)} ${v}`)
        .join('\n')
    }

    case 'tap': {
      const parsed = parseTapArgs(args)
      await client.action({ action: 'tap', ...parsed } as any)
      return `tapped ${args.join(' ')}`
    }

    case 'long-tap': {
      const parsed = parseTapArgs(args)
      await client.action({ action: 'long_tap', ...parsed } as any)
      return `long-tapped ${args.join(' ')}`
    }

    case 'swipe': {
      const parsed = parseSwipeArgs(args)
      await client.action({ action: 'swipe', ...parsed } as any)
      return `swiped ${args.join(' ')}`
    }

    case 'key': {
      const key = args[0]
      if (!key) throw new Error('missing key argument')
      await client.action({ action: 'key', key } as any)
      return `sent key ${key}`
    }

    case 'type': {
      const text = args.join(' ')
      if (!text) throw new Error('missing text argument')
      await client.action({ action: 'type', text } as any)
      return `typed "${text}"`
    }

    case 'set-text': {
      const [ref, ...textParts] = args
      if (!ref) throw new Error('usage: set-text <ref> <text>')
      const text = textParts.join(' ')
      await client.action({ action: 'set_text', ref, text } as any)
      return `set text on ${ref}: "${text}"`
    }

    case 'scroll': {
      const parsed = parseScrollArgs(args)
      await client.action({ action: parsed.action, ref: parsed.ref } as any)
      return `scrolled ${args.join(' ')}`
    }

    case 'open': {
      const uri = args[0]
      if (!uri) throw new Error('missing URI argument')
      await client.open(uri)
      return `opened ${uri}`
    }

    case 'apps': {
      const sub = args[0]
      if (sub === 'launch') {
        const pkg = args[1]
        if (!pkg) throw new Error('missing package name')
        await client.appLaunch(pkg)
        return `launched ${pkg}`
      }
      if (sub === 'stop') {
        const pkg = args[1]
        if (!pkg) throw new Error('missing package name')
        await client.appStop(pkg)
        return `stopped ${pkg}`
      }
      if (sub === 'running') {
        const result = await client.appsRunning()
        return JSON.stringify(result, null, 2)
      }
      // Default: list apps
      const apps = await client.apps()
      return apps.map(a => `${a.package} (${a.label || 'no label'})`).join('\n')
    }

    case 'sms': {
      const sub = args[0]
      if (sub === 'send') {
        const to = args[1]
        const body = args.slice(2).join(' ')
        if (!to || !body) throw new Error('usage: sms send <to> <body>')
        await client.smsSend(to, body)
        return `sent SMS to ${to}`
      }
      if (sub === 'messages') {
        const threadId = parseInt(args[1])
        if (isNaN(threadId)) throw new Error('usage: sms messages <thread_id>')
        const msgs = await client.smsMessages(threadId)
        return JSON.stringify(msgs, null, 2)
      }
      // Default: list threads
      const threads = await client.smsThreads()
      return JSON.stringify(threads, null, 2)
    }

    case 'notifications': {
      const sub = args[0]
      if (sub === 'dismiss') {
        const key = args[1]
        if (!key) throw new Error('usage: notifications dismiss <key>')
        await client.notificationDismiss(key)
        return `dismissed notification ${key}`
      }
      if (sub === 'action') {
        const key = args[1]
        const idx = parseInt(args[2])
        if (!key || isNaN(idx)) throw new Error('usage: notifications action <key> <index>')
        await client.notificationAction(key, idx)
        return `triggered action ${idx} on ${key}`
      }
      const notifs = await client.notifications()
      return JSON.stringify(notifs, null, 2)
    }

    case 'clipboard': {
      const sub = args[0]
      if (sub === 'set') {
        const text = args.slice(1).join(' ')
        await client.clipboardSet(text)
        return 'clipboard set'
      }
      const clip = await client.clipboardGet()
      return clip.text ?? '(empty)'
    }

    case 'contacts': {
      const query = args.length > 0 ? args.join(' ') : undefined
      const contacts = await client.contacts(query)
      return JSON.stringify(contacts, null, 2)
    }

    case 'call': {
      const sub = args[0]
      if (sub === 'dial') {
        const num = args[1]
        if (!num) throw new Error('usage: call dial <number>')
        await client.callDial(num)
        return `dialing ${num}`
      }
      if (sub === 'answer') {
        await client.callAnswer()
        return 'answered call'
      }
      if (sub === 'hangup') {
        await client.callHangup()
        return 'hung up'
      }
      if (sub === 'status') {
        const st = await client.callStatus()
        return JSON.stringify(st, null, 2)
      }
      throw new Error('usage: call <dial|answer|hangup|status>')
    }

    case 'record': {
      const sub = args[0]
      if (sub === 'start') {
        const dur = parseInt(args[1]) || 30
        await client.recordStart(dur)
        return `recording started (max ${dur}s)`
      }
      if (sub === 'stop') {
        const buf = await client.recordStop()
        return `[recording stopped: ${buf.length} bytes]`
      }
      if (sub === 'status') {
        const st = await client.recordStatus()
        return JSON.stringify(st, null, 2)
      }
      throw new Error('usage: record <start|stop|status>')
    }

    case 'wifi': {
      // WiFi commands go to the host API, not per-phone
      // For now, produce a helpful error since WiFi is managed separately
      throw new Error('wifi commands are managed through the host API, not the sandbox otacon command')
    }

    default:
      throw new Error(`unknown command: ${verb}. Available: screenshot, snapshot, info, tap, swipe, key, type, set-text, scroll, open, apps, sms, notifications, clipboard, contacts, call, record`)
  }
}

function parseTapArgs(args: string[]): { x?: number; y?: number; ref?: string } {
  if (args.length >= 2) {
    const x = parseInt(args[0])
    const y = parseInt(args[1])
    if (!isNaN(x) && !isNaN(y)) return { x, y }
  }
  if (args.length >= 1) {
    return { ref: args[0] }
  }
  throw new Error('usage: tap <x> <y> or tap <ref>')
}

function parseSwipeArgs(args: string[]): { x1: number; y1: number; x2: number; y2: number; duration_ms?: number; pause_ms?: number } {
  // swipe x1 y1 x2 y2 [--duration ms] [--pause ms]
  if (args.length < 4) throw new Error('usage: swipe <x1> <y1> <x2> <y2> [--duration ms] [--pause ms]')
  const result: any = {
    x1: parseInt(args[0]),
    y1: parseInt(args[1]),
    x2: parseInt(args[2]),
    y2: parseInt(args[3]),
  }
  const durIdx = args.indexOf('--duration')
  if (durIdx >= 0 && args[durIdx + 1]) {
    result.duration_ms = parseInt(args[durIdx + 1])
  }
  const pauseIdx = args.indexOf('--pause')
  if (pauseIdx >= 0 && args[pauseIdx + 1]) {
    result.pause_ms = parseInt(args[pauseIdx + 1])
  }
  return result
}

function parseScrollArgs(args: string[]): { action: 'scroll_forward' | 'scroll_backward'; ref: string } {
  // scroll <ref> [--direction up|down]
  // Default direction is "down" (scroll_forward). "up" maps to scroll_backward.
  let ref: string | undefined
  let direction = 'down'
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--direction' && args[i + 1]) {
      direction = args[++i]
    } else if (!ref) {
      ref = args[i]
    }
  }
  if (!ref) throw new Error('usage: scroll <ref> [--direction up|down]')
  const action = direction === 'up' ? 'scroll_backward' : 'scroll_forward'
  return { action, ref }
}
