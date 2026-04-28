/**
 * In-memory cache of the current sandbox session's phone allocation.
 *
 * Hidden from bash — the agent has no way to read these values. The `otacon`
 * defineCommand consults this to determine which phone to dispatch against.
 *
 * Carries BOTH the registry phone ID (durable identity, used in DB) and the
 * host-local phone ID (used in URLs). The orchestrator must use
 * `clientBaseUrl` when constructing the OtaconClient — it embeds the
 * host-local ID, never the registry ID.
 */

export interface AllocationData {
  allocationId: string
  /** Registry phone ID (e.g. "phone-4"). Diagnostic + DB pairing. */
  phoneId: string
  /** Host-local phone ID (e.g. "phone-r5ct60sd"). USE THIS in URLs. */
  localPhoneId: string
  /** Host base URL (https://fqdn:port) — no /phones suffix. */
  hostUrl: string
  /** Pre-built OtaconClient base URL: `${hostUrl}/phones/${localPhoneId}`. */
  clientBaseUrl: string
  expiresAt: Date
}

export class AllocationContext {
  private active: AllocationData | null = null

  set(data: AllocationData): void {
    this.active = { ...data }
  }

  /**
   * Returns the active allocation if non-expired, null otherwise.
   * Note: this does NOT clear stale data — callers may want to inspect
   * an expired allocation for error messages. Use `peek()` for that.
   */
  get(): AllocationData | null {
    if (!this.active) return null
    if (this.active.expiresAt <= new Date()) return null
    return this.active
  }

  /** Returns the active allocation regardless of expiry. */
  peek(): AllocationData | null {
    return this.active
  }

  clear(): void {
    this.active = null
  }
}
