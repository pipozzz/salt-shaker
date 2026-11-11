import { eq } from 'drizzle-orm'
import { CLIENT_KINDS, isAudited } from '../src/lib/readonly'
import type { Db, Schema } from './db'

/*
 * Scoped users: an admin can limit someone to the minions a target matches (e.g. G@roles:db).
 * Every call they make on minions is checked against it on the server: the target they asked for is
 * expanded from the master's grains cache, and the call only goes ahead when every minion it
 * matches is in their scope. It then runs on exactly those minions (a list target), so a minion
 * that joins the fleet later can't slip in. Runners and wheel calls that change something run
 * outside any target, so scoped users can't make them.
 */

export interface Scope {
  target: string
  targetType: string
}

/** Which minions a target matches (from the master's grains cache, nothing runs on minions). */
export type Expand = (tgt: string, tgtType: string) => Promise<string[]>

export async function loadScope(db: Db, schema: Schema, userId: string): Promise<Scope | null> {
  const [row] = await db.select().from(schema.userScope).where(eq(schema.userScope.userId, userId)).limit(1)
  return row ? { target: row.target, targetType: row.targetType } : null
}

export type ScopeDecision = { ok: true; low: Record<string, unknown> } | { ok: false; reason: string }

const describe = (s: Scope) => `${s.targetType === 'glob' ? '' : `${s.targetType}:`}${s.target}`
const names = (ids: string[]) => (ids.length <= 5 ? ids.join(', ') : `${ids.slice(0, 5).join(', ')} and ${ids.length - 5} more`)

/** Lets a scoped user's call through, narrowed to their minions, or says why not. */
export async function checkScope(scope: Scope, low: Record<string, unknown>, expand: Expand): Promise<ScopeDecision> {
  const client = String(low.client)
  const kind = CLIENT_KINDS[client as keyof typeof CLIENT_KINDS]
  if (kind !== 'local') {
    if (isAudited(client, String(low.fun))) return { ok: false, reason: `Your access is limited to ${describe(scope)}; ${kind ?? client} ${String(low.fun)} runs outside any target` }
    return { ok: true, low }
  }
  const tgt = typeof low.tgt === 'string' ? low.tgt : ''
  const tgtType = typeof low.tgt_type === 'string' ? low.tgt_type : 'glob'
  const [asked, allowed] = await Promise.all([expand(tgt, tgtType), expand(scope.target, scope.targetType)])
  const mine = new Set(allowed)
  const outside = asked.filter((m) => !mine.has(m)).sort()
  if (outside.length) return { ok: false, reason: `Outside your access (${describe(scope)}): ${names(outside)}` }
  if (!asked.length) return { ok: false, reason: `No minion in your access (${describe(scope)}) matches ${tgt}` }
  return { ok: true, low: { ...low, tgt: [...asked].sort().join(','), tgt_type: 'list' } }
}

/** Expands targets with a short cache, so a burst of calls doesn't ask the master each time. */
export function cachedExpand(expand: Expand, ttlMs = 30_000): Expand {
  const cache = new Map<string, { at: number; ids: Promise<string[]> }>()
  return (tgt, tgtType) => {
    const key = `${tgtType}\0${tgt}`
    const hit = cache.get(key)
    if (hit && Date.now() - hit.at < ttlMs) return hit.ids
    const ids = expand(tgt, tgtType)
    cache.set(key, { at: Date.now(), ids })
    ids.catch(() => cache.delete(key))
    return ids
  }
}
