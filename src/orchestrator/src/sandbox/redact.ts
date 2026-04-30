/**
 * Phone-identifying fields that must NEVER appear in agent-visible output.
 *
 * These are identifiers (adb_serial, IMEI, eSIM EID, BT MACs) that would
 * give the agent a way to learn the phone's identity even though the
 * orchestrator hides phone IDs in env vars and tool descriptions.
 * Stripped from the `info` and `snapshot` payloads on the orchestrator
 * side so the CLI binary (used by humans) still gets the full data.
 *
 * Lifted out of `sandbox/build.ts` so the orchestrator-v2 sandbox
 * (`build-fs.ts`) can share the helper without depending on the legacy
 * Drizzle-flavored module.
 */

const REDACTED_FIELDS = [
  'adb_serial',
  'phone_bt_mac',
  'adapter_mac',
  'imei',
  'imei2',
  'eid',
  'vnc_port',
] as const

/**
 * Strip phone-identifying values from agent-visible command output. Handles
 * both JSON (parsed and re-serialized) and the line-aligned `key  value`
 * text format used by `otacon info`.
 */
export function redactPhoneIdentifiers(out: string): string {
  if (!out) return out
  const trimmed = out.trim()

  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed)
      const redacted = walkRedact(parsed)
      return JSON.stringify(redacted, null, 2)
    } catch {
      // fall through to regex-based redaction
    }
  }

  let result = out
  for (const key of REDACTED_FIELDS) {
    const re = new RegExp(`^(${key}\\s+).+$`, 'gm')
    result = result.replace(re, '$1[redacted]')
  }
  return result
}

function walkRedact(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(walkRedact)
  if (node && typeof node === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(node)) {
      if ((REDACTED_FIELDS as readonly string[]).includes(k)) {
        out[k] = '[redacted]'
      } else {
        out[k] = walkRedact(v)
      }
    }
    return out
  }
  return node
}
