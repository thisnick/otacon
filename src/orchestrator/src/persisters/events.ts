/**
 * events.jsonl persister — appends every OtaconEvent verbatim for replay
 * by UI consumers (live tail or after-the-fact).
 *
 * The entire OtaconEvent is JSON-stringified per line. Pi's events that
 * may contain non-serializable values (e.g. AbortSignal) shouldn't reach
 * the bus, but if they do `JSON.stringify` will throw — caught here so a
 * single bad event doesn't crash the persister.
 */
import { appendEventLine } from '../storage/session.js'
import type { OtaconEvent } from '../types.js'
import type { Listener } from '../runtime/session-bus.js'

export interface EventsPersisterOpts {
  dataRoot: string
  workspaceId: string
  teamName: string
  sessionId: string
}

export function makeEventsPersister(opts: EventsPersisterOpts): Listener {
  const { dataRoot, workspaceId, teamName, sessionId } = opts
  return (event: OtaconEvent) => {
    let line: string
    try {
      line = JSON.stringify(event)
    } catch (err) {
      console.error('[events-persister] stringify failed:', err)
      return
    }
    appendEventLine(dataRoot, workspaceId, teamName, sessionId, line).catch(err => {
      console.error('[events-persister] append failed:', err)
    })
  }
}
