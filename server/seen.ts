import { min } from 'drizzle-orm'
import { Hono } from 'hono'
import type { Db, Schema } from './db'
import type { Env } from './types'

/*
 * When each minion last answered the presence check. Salt itself doesn't keep this, and it's what
 * tells a minion that is briefly down from a machine that was decommissioned months ago but whose
 * key is still accepted (and counted, targeted and scanned).
 */

/** Marks the minions that answered as seen now. */
export async function recordSeen(db: Db, schema: Schema, up: string[], now = new Date()) {
  const t = schema.minionSeen
  for (let i = 0; i < up.length; i += 500) {
    const rows = up.slice(i, i + 500).map((minion) => ({ minion, lastSeenAt: now }))
    await db.insert(t).values(rows).onConflictDoUpdate({ target: t.minion, set: { lastSeenAt: now } })
  }
}

/** Every minion's last answer, and since when answers are recorded (a minion with none hasn't answered since then). */
export async function lastSeen(db: Db, schema: Schema) {
  const t = schema.minionSeen
  const rows = await db.select().from(t)
  const [first] = await db.select({ since: min(t.lastSeenAt) }).from(t)
  return {
    seen: Object.fromEntries(rows.map((r) => [r.minion, new Date(r.lastSeenAt).toISOString()])),
    since: first?.since ? new Date(first.since).toISOString() : null,
  }
}

export function seenRoutes({ db, schema, checking }: { db: Db; schema: Schema; checking: boolean }) {
  const r = new Hono<Env>()
  r.get('/minions/seen', async (c) => {
    if (!c.get('user')) return c.json({ error: 'Not signed in' }, 401)
    return c.json({ ...(await lastSeen(db, schema)), checking })
  })
  return r
}
