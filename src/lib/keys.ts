/**
 * The cards on the Keys page. One minion id can sit in two of them at once: after a reinstall its
 * old key stays accepted while the new one is denied. So what's picked, and each key's fingerprint,
 * is kept per card and never by id alone.
 */
export type KeySection = 'pending' | 'accepted' | 'refused'

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
