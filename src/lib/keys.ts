/**
 * The cards on the Keys page. One minion id can sit in two of them at once: after a reinstall its
 * old key stays accepted while the new one is denied. So what's picked, and each key's fingerprint,
 * is kept per card and never by id alone.
 */
import type { KeyStatus } from '../api/types'

export type KeySection = 'pending' | 'accepted' | 'refused'

/** The key list a row of a card stands for: a refused key is denied or rejected. */
export function listOf(section: KeySection, id: string, denied: readonly string[]): KeyStatus {
  if (section === 'pending') return 'minions_pre'
  if (section === 'accepted') return 'minions'
  return denied.includes(id) ? 'minions_denied' : 'minions_rejected'
}

/**
 * A denied key whose id also has an accepted one: the same minion with a new key, usually after a
 * reinstall. Accepting it replaces the accepted key.
 */
export const replacesAccepted = (id: string, keys: { minions: readonly string[]; minions_denied: readonly string[] }) => keys.minions_denied.includes(id) && keys.minions.includes(id)

/** How much of a fingerprint a row shows before it's opened: the first 8 bytes. */
export const shortFinger = (finger: string) => (finger.length > 23 ? `${finger.slice(0, 23)}…` : finger)

export type PickedKeys = Record<KeySection, ReadonlySet<string>>

export const noKeysPicked = (): PickedKeys => ({ pending: new Set(), accepted: new Set(), refused: new Set() })

/** Picks or unpicks ids in one card, leaving the same ids in the other cards as they were. */
export function pickKeys(prev: PickedKeys, section: KeySection, ids: string[], on: boolean): PickedKeys {
  const next = new Set(prev[section])
  for (const id of ids) {
    if (on) next.add(id)
    else next.delete(id)
  }
  return { ...prev, [section]: next }
}

/** key.finger's reply: fingerprints by key list (minions, minions_pre, minions_rejected, minions_denied), then by id. */
export type KeyFingers = Partial<Record<string, Record<string, string>>>

/** The fingerprints of the key lists one card shows. */
export function fingersOf(fingers: KeyFingers | undefined, ...lists: string[]): Record<string, string> {
  return Object.assign({}, ...lists.map((l) => fingers?.[l]))
}
