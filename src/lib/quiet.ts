import type { MinionsSeen } from '../api/server'

const DAY = 86400_000

export interface Quiet {
  id: string
  /** when it last answered, or null when it hasn't since `since` */
  lastSeen: string | null
}

/** Accepted minions that don't answer now and haven't for at least `days`, longest quiet first. */
export function quietMinions(accepted: string[], down: string[], seen: MinionsSeen, days: number, now = Date.now()): Quiet[] {
  const cutoff = now - days * DAY
  const isDown = new Set(down)
  const out: Quiet[] = []
  for (const id of accepted) {
    if (!isDown.has(id)) continue
    const last = seen.seen[id] ?? null
    if (last ? Date.parse(last) < cutoff : seen.since !== null && Date.parse(seen.since) < cutoff) out.push({ id, lastSeen: last })
  }
  // never seen first, then the longest quiet
  return out.sort((a, b) => (a.lastSeen ?? '').localeCompare(b.lastSeen ?? '') || a.id.localeCompare(b.id))
}

