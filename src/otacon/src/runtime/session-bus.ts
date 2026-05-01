/**
 * Event bus for a single session.
 *
 * Wired:
 *   - Pi's `agent.subscribe(piEvent => bus.emit({kind:'pi', event:piEvent, ts:Date.now()}))`
 *   - Tools / approval gate emit custom events directly via closure-captured bus
 *   - Subscribers: console printer, messages persister, events persister
 *
 * Listeners are invoked synchronously in subscription order. Async work is
 * the listener's responsibility; the bus does not await.
 */
import type { OtaconEvent } from '../types.js'

export type Listener = (event: OtaconEvent) => void

export class SessionBus {
  private listeners = new Set<Listener>()

  emit(event: OtaconEvent): void {
    for (const l of this.listeners) {
      try {
        l(event)
      } catch (err) {
        console.error('[session-bus] listener threw:', err)
      }
    }
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
}
