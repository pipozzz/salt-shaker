import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { afterEach, describe, expect, it } from 'vitest'
import { batchCount, ChangeRunner, needsApproval, validBatchSize } from './changes'
import { changeRoutes } from './routes/changes'
import type { Expand } from './scope'
import { openTestDatabase, testDialects } from './testdb'
import type { Env } from './types'

describe('batches and approval', () => {
  it('sizes batches by count or share', () => {
    expect([batchCount('', 10), batchCount(null, 10), batchCount('3', 10), batchCount('25%', 10), batchCount('50%', 3), batchCount('20', 4)]).toEqual([10, 10, 3, 3, 2, 4])
    expect(['', '5', '25%', '12.5%'].every(validBatchSize)).toBe(true)
    expect(['five', '-1', '%'].some(validBatchSize)).toBe(false)
  })

  it('asks for approval of what changes minions, from non-admins, when the policy says so', () => {
    expect(needsApproval('risky', 'operator', 'state.apply', {})).toBe(true)
    expect(needsApproval('risky', 'operator', 'state.apply', { test: true })).toBe(false)
    expect(needsApproval('risky', 'operator', 'test.ping', {})).toBe(false)
    expect(needsApproval('risky', 'admin', 'cmd.run', {})).toBe(false)
    expect(needsApproval('off', 'operator', 'cmd.run', {})).toBe(false)
  })
})

const FLEET = ['web-01', 'web-02', 'web-03', 'web-04', 'web-05']
const expand: Expand = async (tgt) => (tgt === 'web-*' ? FLEET : [])

describe.each(testDialects)('changes (%s)', (dialect) => {
  let close: (() => Promise<unknown>) | null = null
  afterEach(async () => {
    await close?.()
    close = null
  })

  async function setup(approval: 'off' | 'risky' = 'off') {
    const opened = await openTestDatabase(dialect)
    close = opened.close
    const { db, schema } = opened
    let n = 0
    const calls: Array<Record<string, unknown>> = []
    const salt = { call: async (low: Record<string, unknown>) => (calls.push(low), { jid: `2026111100000000000${++n}`, minions: String(low.tgt).split(',') }) }
    const sent: string[] = []
    const notifier = { emit: async (event: string, m: { title: string }) => void sent.push(`${event}: ${m.title}`) }
    const audited: string[] = []
    const audit = async (r: { fun: string }) => void audited.push(r.fun)
    let now = Date.UTC(2026, 10, 11, 12)
    const runner = new ChangeRunner({ db, schema, salt, notifier, audit, expand, now: () => now })
    const app = new Hono<Env>()
    app.use('*', async (c, next) => {
      const [name, role] = (c.req.header('x-user') ?? '').split(':')
      c.set('user', name ? { id: `u-${name}`, name, username: name, role } : null)
      await next()
    })
    app.route('/api', changeRoutes({ db, schema, runner, notifier, audit, expand, approval }))
    const call = async (user: string, method: string, path: string, body?: unknown) => {
      const res = await app.request(`/api${path}`, { method, headers: { 'x-user': user, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
      return { status: res.status, body: (await res.json()) as Record<string, unknown> }
    }
    const returns = async (jid: string, minions: string[], failed: string[] = []) =>
      db.insert(schema.jobReturn).values(minions.map((minion) => ({ jid, minion, ret: '{}', retcode: failed.includes(minion) ? 2 : 0, success: !failed.includes(minion), returnedAt: new Date(now) })))
    const get = async (id: number) => (await db.select().from(schema.change).where(eq(schema.change.id, id)))[0]
    return { db, schema, runner, call, calls, sent, audited, returns, get, advance: (ms: number) => (now += ms) }
  }

  it('rolls out batch by batch and finishes', async () => {
    const s = await setup()
    const created = await s.call('olga:operator', 'POST', '/changes', { reason: 'nginx 1.26', target: 'web-*', targetType: 'glob', fun: 'pkg.install', arg: [], kwarg: { name: 'nginx' }, batchSize: '40%', maxFailures: 0 })
    expect(created.status).toBe(201)
    const id = (created.body.change as { id: number }).id
    // creating it worked out the minions; the next pass starts the first batch
    await s.runner.tick()
    expect(s.calls.map((c) => c.tgt)).toEqual(['web-01,web-02'])
    expect(s.calls[0]).toMatchObject({ client: 'local_async', tgt_type: 'list', fun: 'pkg.install', kwarg: { name: 'nginx' }, metadata: { salt_shaker_user: 'olga', salt_shaker_change: id } })
    // nothing new until the batch has returned
    await s.runner.tick()
    expect(s.calls).toHaveLength(1)
    await s.returns('20261111000000000001', ['web-01', 'web-02'])
    await s.runner.tick()
    await s.returns('20261111000000000002', ['web-03', 'web-04'])
    await s.runner.tick()
    await s.returns('20261111000000000003', ['web-05'])
    await s.runner.tick()
    expect(s.calls.map((c) => c.tgt)).toEqual(['web-01,web-02', 'web-03,web-04', 'web-05'])
    expect((await s.get(id)).status).toBe('done')
    expect(s.sent).toEqual([`change: Change #${id} finished: pkg.install on web-*`])
    // in the job history, as the requester
    const [job] = await s.db.select().from(s.schema.job).where(eq(s.schema.job.jid, '20261111000000000001'))
    expect(job).toMatchObject({ shakerUser: 'olga', target: 'web-01,web-02' })
  })

  it('stops when more minions fail than allowed, counting the ones that never answer', async () => {
    const s = await setup()
    const id = ((await s.call('olga:operator', 'POST', '/changes', { reason: 'restart', target: 'web-*', targetType: 'glob', fun: 'service.restart', arg: ['nginx'], batchSize: '2', maxFailures: 1 })).body.change as { id: number }).id
    await s.runner.tick()
    await s.returns('20261111000000000001', ['web-01', 'web-02'], ['web-02'])
    await s.runner.tick()
    // web-04 never answers; after the deadline it counts as failed too
    await s.returns('20261111000000000002', ['web-03'])
    s.advance(16 * 60_000)
    await s.runner.tick()
    const row = await s.get(id)
    expect(row.status).toBe('stopped')
    expect(row.error).toBe('2 minions failed (web-02, web-04); at most 1 allowed')
    expect(s.calls).toHaveLength(2)
    expect(s.sent).toEqual([`change: Change #${id} stopped: service.restart on web-*`])
  })

  it("needs another admin's approval for an operator's risky change", async () => {
    const s = await setup('risky')
    const ping = await s.call('olga:operator', 'POST', '/changes', { reason: 'check', target: 'web-*', targetType: 'glob', fun: 'test.ping' })
    expect((ping.body.change as { status: string }).status).toBe('queued')
    const req = await s.call('olga:operator', 'POST', '/changes', { reason: 'patch openssl', target: 'web-*', targetType: 'glob', fun: 'pkg.upgrade' })
    const id = (req.body.change as { id: number; status: string }).id
    expect((req.body.change as { status: string }).status).toBe('pending')
    expect(s.sent).toEqual([`approval: Change #${id} waits for approval: pkg.upgrade on web-*`])

    expect((await s.call('olga:operator', 'POST', `/changes/${id}/approve`)).status).toBe(403)
    expect((await s.call('ada:admin', 'POST', `/changes/${id}/reject`, {})).status).toBe(400)
    expect((await s.call('ada:admin', 'POST', `/changes/${id}/approve`, { note: 'ok for today' })).status).toBe(200)
    // approved, it starts right away
    expect(await s.get(id)).toMatchObject({ status: 'running', decidedBy: 'ada', decisionNote: 'ok for today' })
    expect((await s.call('ada:admin', 'POST', `/changes/${id}/approve`)).status).toBe(409)

    // an admin can't approve their own
    const own = ((await s.call('bob:admin', 'POST', '/changes', { reason: 'x', target: 'web-*', targetType: 'glob', fun: 'cmd.run', arg: ['true'] })).body.change as { status: string })
    expect(own.status).toBe('queued')

    // viewers can't request what they can't run
    expect((await s.call('vic:viewer', 'POST', '/changes', { reason: 'x', target: 'web-*', targetType: 'glob', fun: 'cmd.run', arg: ['id'] })).status).toBe(403)
    expect(s.audited.filter((f) => f.startsWith('change.') || f === 'cmd.run')).toEqual(['change.request', 'change.request', 'change.approve', 'change.request', 'cmd.run'])
  })

  it('lets the requester stop it', async () => {
    const s = await setup('risky')
    const id = ((await s.call('olga:operator', 'POST', '/changes', { reason: 'r', target: 'web-*', targetType: 'glob', fun: 'state.apply' })).body.change as { id: number }).id
    expect((await s.call('otto:operator', 'POST', `/changes/${id}/stop`)).status).toBe(403)
    expect((await s.call('olga:operator', 'POST', `/changes/${id}/stop`)).status).toBe(200)
    expect(await s.get(id)).toMatchObject({ status: 'stopped', error: 'Stopped by olga' })
    expect((await s.call('olga:operator', 'POST', `/changes/${id}/stop`)).status).toBe(409)
    const detail = await s.call('olga:operator', 'GET', `/changes/${id}`)
    expect(detail.body.change).toMatchObject({ id, batches: [], args: { arg: [], kwarg: {} } })
  })
})
