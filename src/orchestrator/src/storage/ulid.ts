/**
 * ULID helpers — re-exported so callers don't need to depend on `ulid`
 * directly, plus a `tsFromUlid()` decoder for surfacing event timestamps from
 * chunk IDs (cheaper than carrying a separate `ts` field).
 */
import { ulid as makeUlid } from 'ulid'

export function ulid(): string {
  return makeUlid()
}

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const ALPHABET_INDEX = (() => {
  const idx: Record<string, number> = {}
  for (let i = 0; i < ALPHABET.length; i++) idx[ALPHABET[i]] = i
  return idx
})()

/**
 * Decode the millisecond timestamp prefix of a Crockford-base32 ULID. The
 * first 10 characters encode the 48-bit unix-ms timestamp.
 *
 * Returns NaN if the input doesn't look like a ULID — caller decides whether
 * that's fatal.
 */
export function tsFromUlid(id: string): number {
  if (!id || id.length < 10) return NaN
  let ts = 0
  for (let i = 0; i < 10; i++) {
    const c = id[i].toUpperCase()
    const v = ALPHABET_INDEX[c]
    if (v === undefined) return NaN
    ts = ts * 32 + v
  }
  return ts
}
