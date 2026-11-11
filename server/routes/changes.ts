import { and, desc, eq, inArray } from 'drizzle-orm'
import { Hono } from 'hono'
import { changeMessage, needsApproval, validBatchSize, type Batch, type ChangeRunner } from '../changes'
import type { Db, Schema } from '../db'
import type { Notifier } from '../notify'
import { authorize } from '../policy'
import { checkScope, loadScope, type Expand } from '../scope'
import type { AuditRow, Env } from '../types'
import { TARGET_TYPES } from './automation'

interface Deps {
  db: Db
  schema: Schema
  runner: ChangeRunner
  notifier: Pick<Notifier, 'emit'>
  audit: (row: AuditRow) => Promise<unknown>
  expand: Expand
  approval: 'off' | 'risky'
}

/** Changes: batched rollouts, and the approvals the policy asks for. See server/changes.ts. */
export function changeRoutes({ db, schema, runner, notifier, audit, expand, approval }: Deps) {
  const r = new Hono<Env>()
  const t = schema.change

  for (const path of ['/changes', '/changes/*']) {
    r.use(path, async (c, next) => {
      const user = c.get('user')
      if (!user) return c.json({ error: 'Not signed in' }, 401)
      if (user.role === 'none') return c.json({ error: 'No role' }, 403)
      await next()
    })
  }
  const who = (c: { get: (k: 'user') => Env['Variables']['user'] }) => {
    const u = c.get('user')!
    return { userId: u.id, username: u.username ?? u.name, role: u.role ?? null }
  }
  const view = (row: Schema['change']['$inferSelect']) => ({
    ...row,
    args: JSON.parse(row.args) as { arg: unknown[]; kwarg: Record<string, unknown> },
    minions: row.minions ? (JSON.parse(row.minions) as string[]) : null,
    batches: JSON.parse(row.batches) as Batch[],
  })

  r.get('/changes', async (c) => {
    const rows = await db.select().from(t).orderBy(desc(t.id)).limit(200)
    return c.json({ changes: rows.map(view), approval })
  })

  r.get('/changes/:id', async (c) => {
    const [row] = await db.select().from(t).where(eq(t.id, Number(c.req.param('id'))))
    if (!row) return c.json({ error: 'Not found' }, 404)
    const v = view(row)
    const p = await runner.progress(v.batches)
    // each minion's outcome so far, for the progress view
    const outcome: Record<string, 'ok' | 'failed' | 'running' | 'waiting'> = {}
    for (const m of v.minions ?? []) outcome[m] = 'waiting'
    for (const b of v.batches) for (const m of b.minions) outcome[m] = 'running'
    for (const x of p.returns) outcome[x.minion] = (x.retcode ?? 0) !== 0 || x.success === false ? 'failed' : 'ok'
    for (const m of p.failed) outcome[m] = 'failed'
    return c.json({ change: v, outcome })
  })

  r.post('/changes', async (c) => {
    const me = who(c)
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
    const reason = typeof body.reason === 'string' ? body.reason.trim() : ''
    const target = typeof body.target === 'string' ? body.target.trim() : ''
    const targetType = typeof body.targetType === 'string' ? body.targetType : 'glob'
    const fun = typeof body.fun === 'string' ? body.fun.trim() : ''
    const arg = Array.isArray(body.arg) ? body.arg : []
    const kwarg = body.kwarg && typeof body.kwarg === 'object' && !Array.isArray(body.kwarg) ? (body.kwarg as Record<string, unknown>) : {}
    const batchSize = typeof body.batchSize === 'string' ? body.batchSize.trim() : ''
    const maxFailures = Number(body.maxFailures ?? 0)
    if (!reason || reason.length > 2000) return c.json({ error: 'Say what the change is for (max 2000 characters)' }, 400)
    if (!target) return c.json({ error: 'A target is required' }, 400)
    if (!TARGET_TYPES.includes(targetType)) return c.json({ error: 'Unknown target type' }, 400)
    if (!validBatchSize(batchSize)) return c.json({ error: 'Batch size is a number of minions or a percentage, e.g. 5 or 25%' }, 400)
    if (!Number.isInteger(maxFailures) || maxFailures < 0) return c.json({ error: 'Failures allowed is a whole number, 0 or more' }, 400)

    // the same checks as running it directly: the role, then the requester's scope
    const decision = authorize(me.role, me.username, { client: 'local_async', tgt: target, tgt_type: targetType, fun, arg, kwarg })
    if (!decision.ok) {
      await audit({ ...me, client: 'local_async', fun: fun || '?', target, targetType, outcome: 'denied', error: decision.reason })
      return c.json({ error: decision.reason }, decision.status)
    }
    const scope = await loadScope(db, schema, me.userId)
    if (scope) {
      const ok = await checkScope(scope, { client: 'local_async', fun, tgt: target, tgt_type: targetType }, expand)
      if (!ok.ok) {
        await audit({ ...me, client: 'local_async', fun, target, targetType, outcome: 'denied', error: ok.reason })
        return c.json({ error: ok.reason }, 403)
      }
    }
    const pending = needsApproval(approval, me.role, fun, kwarg)
    const [row] = await db
      .insert(t)
      .values({ reason, target, targetType, fun, args: JSON.stringify({ arg, kwarg }), batchSize: batchSize || null, maxFailures, status: pending ? 'pending' : 'queued', requestedBy: me.username, requestedById: me.userId, requestedAt: new Date() })
      .returning()
    await audit({ ...me, client: 'console', fun: 'change.request', target: `#${row.id} ${fun} → ${target}`, args: JSON.stringify({ reason, batchSize, maxFailures, arg, kwarg }), outcome: 'ok' })
    if (pending) await notifier.emit('approval', changeMessage(row, 'pending'))
    // a change that needs no approval starts right away (the runner's next pass would anyway)
    else await runner.tick()
    return c.json({ change: view(row) }, 201)
  })

  const decide = (verdict: 'approve' | 'reject') =>
    r.post(`/changes/:id/${verdict}`, async (c) => {
      const me = who(c)
      if (me.role !== 'admin') return c.json({ error: 'Only admins approve changes' }, 403)
      const id = Number(c.req.param('id'))
      const [row] = await db.select().from(t).where(eq(t.id, id))
      if (!row) return c.json({ error: 'Not found' }, 404)
      if (row.status !== 'pending') return c.json({ error: `Change #${id} isn't waiting for approval` }, 409)
      // four eyes: someone else decides
      if (row.requestedById === me.userId) return c.json({ error: 'Someone other than the requester has to decide' }, 403)
      const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
      const note = typeof body.note === 'string' ? body.note.trim().slice(0, 1000) || null : null
      if (verdict === 'reject' && !note) return c.json({ error: 'Say why it is rejected' }, 400)
      const done = await db
        .update(t)
        .set({ status: verdict === 'approve' ? 'queued' : 'rejected', decidedBy: me.username, decidedAt: new Date(), decisionNote: note })
        .where(and(eq(t.id, id), eq(t.status, 'pending')))
        .returning({ id: t.id })
      if (!done.length) return c.json({ error: 'Someone decided first' }, 409)
      await audit({ ...me, client: 'console', fun: `change.${verdict}`, target: `#${id} ${row.fun} → ${row.target}`, args: note ? JSON.stringify({ note }) : null, outcome: 'ok' })
      if (verdict === 'approve') await runner.tick()
      return c.json({ ok: true })
    })
  decide('approve')
  decide('reject')

  /** Stops starting batches (the running one finishes); the requester or an admin. */
  r.post('/changes/:id/stop', async (c) => {
    const me = who(c)
    const id = Number(c.req.param('id'))
    const [row] = await db.select().from(t).where(eq(t.id, id))
    if (!row) return c.json({ error: 'Not found' }, 404)
    if (me.role !== 'admin' && row.requestedById !== me.userId) return c.json({ error: 'Only the requester or an admin can stop it' }, 403)
    const done = await db
      .update(t)
      .set({ status: 'stopped', finishedAt: new Date(), error: `Stopped by ${me.username}` })
      .where(and(eq(t.id, id), inArray(t.status, ['pending', 'queued', 'running'])))
      .returning({ id: t.id })
    if (!done.length) return c.json({ error: `Change #${id} isn't running` }, 409)
    await audit({ ...me, client: 'console', fun: 'change.stop', target: `#${id} ${row.fun} → ${row.target}`, outcome: 'ok' })
    return c.json({ ok: true })
  })

  return r
}

