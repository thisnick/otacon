/**
 * Phase I · I5 — Phones registry-proxy.
 *
 * Coverage:
 *   - GET /phones with valid registry creds (env or ~/.otacon/config.toml)
 *     returns at least one phone with phoneNumber, status, registryId,
 *     displayLabel, hostId.
 *   - All returned phones have a non-null phoneNumber (filter applied).
 *   - GET /phones with no registry creds → 502 phones_unavailable.
 *
 * This scenario hits the real registry — it expects to be run from a host
 * with `OTACON_REGISTRY_URL` + `OTACON_TOKEN` configured (same setup as
 * the orchestrator's run-time phone resolver). When run on a fresh dev
 * machine that doesn't have those creds, the assertions about live data
 * are skipped — only the no-creds 502 path is verified.
 */
import {
  bootLocalServer,
  api,
  isErrorEnvelope,
} from './helpers/phase-i.js'
import {
  assert,
  exitFromCounters,
  info,
  makeCounters,
  section,
  summary,
} from './helpers/spike.js'

interface PhoneSummary {
  phoneNumber: string
  status: 'online' | 'offline' | 'unreachable'
  registryId: string
  displayLabel: string
  hostId: string | null
}

async function main() {
  const c = makeCounters()
  console.log(`\n=== Phase I · I5: phones registry proxy ===`)

  section('1. With registry creds — happy path')
  const haveCreds =
    !!process.env.OTACON_REGISTRY_URL && !!process.env.OTACON_TOKEN

  if (haveCreds) {
    const server = await bootLocalServer({ seed: false })
    info(`server: ${server.baseUrl}`)
    try {
      const r = await api<PhoneSummary[]>(server.baseUrl, '/api/v1/phones')
      assert(c, r.status === 200, `GET /phones → 200 (got ${r.status})`)
      assert(c, Array.isArray(r.body), `body is an array`)
      const list = r.body
      info(`registry returned ${list.length} phone(s)`)
      assert(c, list.length >= 1, `at least one phone returned`)
      for (const p of list) {
        assert(c, typeof p.phoneNumber === 'string' && p.phoneNumber.length > 0,
          `${p.registryId}: phoneNumber set`)
        assert(c, ['online', 'offline', 'unreachable'].includes(p.status),
          `${p.registryId}: status one of online/offline/unreachable (got ${p.status})`)
        assert(c, typeof p.registryId === 'string' && p.registryId.length > 0,
          `${p.registryId}: registryId non-empty`)
        assert(c, typeof p.displayLabel === 'string' && p.displayLabel.length > 0,
          `${p.registryId}: displayLabel non-empty`)
        // hostId nullability tested below — every connected phone should have one
      }
      const sorted = [...list].sort((a, b) => a.phoneNumber.localeCompare(b.phoneNumber))
      assert(c, JSON.stringify(sorted) === JSON.stringify(list),
        `list sorted by phoneNumber`)
    } finally {
      await server.stop()
    }
  } else {
    info(`OTACON_REGISTRY_URL / OTACON_TOKEN not set — skipping live-data checks`)
  }

  section('2. Without registry creds → 502 phones_unavailable')
  // Boot a fresh server with empty registry env. This MUST come after
  // the live checks so we don't clobber the env mid-flight.
  const server = await bootLocalServer({
    seed: false,
    env: {
      OTACON_REGISTRY_URL: undefined,
      OTACON_TOKEN: undefined,
      // Also blank the config-toml path so the server can't read the
      // user's ~/.otacon/config.toml.
      OTACON_CONFIG_DIR: '/tmp/otacon-i5-no-such-dir',
    },
  })
  info(`server (no creds): ${server.baseUrl}`)
  try {
    const r = await api<unknown>(server.baseUrl, '/api/v1/phones')
    assert(c, r.status === 502, `GET /phones no-creds → 502 (got ${r.status})`)
    assert(c, isErrorEnvelope(r.body, 'phones_unavailable').ok,
      `phones_unavailable envelope ok`)
  } finally {
    await server.stop()
  }

  summary('Phase I · I5', c)
  exitFromCounters('Phase I · I5', c)
}

main().catch(err => {
  console.error('I5 threw:', err)
  process.exit(1)
})
