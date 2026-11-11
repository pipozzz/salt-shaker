import { and, desc, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import type { Db, Schema } from './db'
import type { Message } from './summaries'
import type { AuditRow, Env } from './types'

/*
 * Enrollment windows: for a while, new minions whose id matches a pattern are accepted without a
 * click, at most so many. Any machine can ask for any id, so this only makes sense while you're
 * bringing up servers you know about, on a network you trust; a window always ends (72 hours at
 * most) and stops after its last accept. Only the instance that follows the event bus acts on it.
 */

type Rule = Schema['keyRule']['$inferSelect']

/** Glob matching for minion ids: * any run of characters, ? one, the rest literal. */
export function globMatch(pattern: string, id: string) {
  const re = new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`)
  return re.test(id)
}

/** A pattern has to name something: at least three characters that aren't wildcards. */
export const specificEnough = (pattern: string) => pattern.replace(/[*?]/g, '').length >= 3 && !/\s/.test(pattern)

interface Deps {
  db: Db
  schema: Schema
  salt: { call(low: Record<string, unknown>): Promise<unknown> }
  notify: (msg: Message) => Promise<unknown>
  audit: (row: AuditRow) => Promise<unknown>
  now?: () => number
}

export class KeyAutoAccept {
  private now: () => number
  constructor(private d: Deps) {
    this.now = d.now ?? Date.now
  }

  /** For master events: accepts a pending key when an open window matches its id. */
  async onEvent(tag: string, data: Record<string, unknown>) {
    if (tag !== 'salt/auth' || data.act !== 'pend' || typeof data.id !== 'string') return
    const id = data.id
    const t = this.d.schema.keyRule
    const now = new Date(this.now())
    for (const rule of await this.d.db.select().from(t)) {
      const accepted = JSON.parse(rule.accepted) as string[]
      if (rule.expiresAt <= now || accepted.length >= rule.maxAccepts || accepted.includes(id) || !globMatch(rule.pattern, id)) continue
      // claim the slot first, so two events for the same window can't go over its limit
      const claimed = await this.d.db
        .update(t)
        .set({ accepted: JSON.stringify([...accepted, id]) })
        .where(and(eq(t.id, rule.id), eq(t.accepted, rule.accepted)))
        .returning({ id: t.id })
      if (!claimed.length) continue
      return this.accept(rule, id, accepted.length + 1)
    }
  }

  private async accept(rule: Rule, id: string, count: number) {
    const who = `rule:${rule.pattern}`
    try {
      await this.d.salt.call({ client: 'wheel', fun: 'key.accept', match: id })
      await this.d.audit({ username: who, role: 'system', client: 'wheel', fun: 'key.accept', target: id, args: JSON.stringify({ rule: rule.id, by: rule.createdBy }), outcome: 'ok' })
      await this.d.notify({
        title: `Minion accepted by an enrollment window: ${id}`,
        lines: [`Window ${rule.pattern} (${count} of at most ${rule.maxAccepts}), opened by ${rule.createdBy ?? 'an admin'}`],
        severity: 'info',
        path: `/minions/${encodeURIComponent(id)}`,
      })
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e)
      await this.d.audit({ username: who, role: 'system', client: 'wheel', fun: 'key.accept', target: id, outcome: 'error', error })
    }
  }
}

export function keyRuleRoutes({ db, schema, audit }: { db: Db; schema: Schema; audit: (row: AuditRow) => Promise<unknown> }) {
  const r = new Hono<Env>()
  const t = schema.keyRule
  for (const path of ['/key-rules', '/key-rules/*']) {
    r.use(path, async (c, next) => {
      const user = c.get('user')
      if (!user) return c.json({ error: 'Not signed in' }, 401)
      if (user.role !== 'admin') return c.json({ error: 'Admins only' }, 403)
      await next()
    })
  }
  const who = (c: { get: (k: 'user') => Env['Variables']['user'] }) => {
    const u = c.get('user')!
    return { userId: u.id, username: u.username ?? u.name, role: u.role ?? null }
  }
  const view = (row: Rule) => ({ ...row, accepted: JSON.parse(row.accepted) as string[] })

  r.get('/key-rules', async (c) => c.json({ rules: (await db.select().from(t).orderBy(desc(t.id)).limit(50)).map(view) }))

  r.post('/key-rules', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
    const pattern = typeof body.pattern === 'string' ? body.pattern.trim() : ''
    const hours = Number(body.hours)
    const maxAccepts = Number(body.maxAccepts)
    if (!specificEnough(pattern)) return c.json({ error: 'The pattern has to name the minions, e.g. web-2026-* (at least 3 characters besides * and ?)' }, 400)
    if (!(Number.isInteger(hours) && hours >= 1 && hours <= 72)) return c.json({ error: 'A window stays open 1 to 72 hours' }, 400)
    if (!(Number.isInteger(maxAccepts) && maxAccepts >= 1 && maxAccepts <= 500)) return c.json({ error: 'It accepts 1 to 500 minions' }, 400)
    const now = new Date()
    const [row] = await db.insert(t).values({ pattern, expiresAt: new Date(+now + hours * 3600_000), maxAccepts, accepted: '[]', createdBy: who(c).username, createdAt: now }).returning()
    await audit({ ...who(c), client: 'console', fun: 'keys.open_window', target: pattern, args: JSON.stringify({ hours, maxAccepts }), outcome: 'ok' })
    return c.json({ rule: view(row) }, 201)
  })

  /** Closes a window now (it stays listed with what it accepted). */
  r.post('/key-rules/:id/close', async (c) => {
    const id = Number(c.req.param('id'))
    const [row] = await db.select().from(t).where(eq(t.id, id))
    if (!row) return c.json({ error: 'Not found' }, 404)
    await db.update(t).set({ expiresAt: new Date() }).where(eq(t.id, id))
    await audit({ ...who(c), client: 'console', fun: 'keys.close_window', target: row.pattern, outcome: 'ok' })
    return c.json({ ok: true })
  })

  return r
}
