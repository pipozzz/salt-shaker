import { Hono } from 'hono'
import { afterEach, describe, expect, it } from 'vitest'
import type { JobRet } from './history'
import { MinionCollector, minionRoutes, minionState, upgradeCount } from './minions'
import { openTestDatabase, testDialects } from './testdb'
import type { Env } from './types'

it('counts the upgrades of a patch scan, and none for a failed one', () => {
  expect(upgradeCount('{"nginx":"1.2","curl":"8"}', 0)).toBe(2)
  expect(upgradeCount('{}', 0)).toBe(0)
  expect(upgradeCount('"E: could not get lock"', 0)).toBeNull()
  expect(upgradeCount('{"nginx":"1.2"}', 1)).toBeNull()
  expect(upgradeCount('{"_truncated":true,"bytes":900000}', 0)).toBeNull()
  expect(upgradeCount(null, 0)).toBeNull()
})

describe.each(testDialects)('MinionCollector (%s)', (dialect) => {
  let close: (() => Promise<unknown>) | null = null
  afterEach(async () => {
    await close?.()
    close = null
  })
  const at = (m: number) => new Date(Date.UTC(2026, 10, 19, 12, m))

  /** A master with these keys, grains and answers; counts what it was asked. */
  function master(m: { accepted: string[]; grains?: Record<string, unknown>; up?: string[] }) {
    const asked: string[] = []
    const call = async (low: Record<string, unknown>) => {
      asked.push(String(low.fun))
      if (low.fun === 'key.list_all') return { data: { return: { minions: m.accepted, minions_pre: [] }, success: true } }
      if (low.fun === 'cache.grains') return m.grains ?? {}
      if (low.fun === 'manage.status') return { up: m.up ?? [], down: m.accepted.filter((id) => !(m.up ?? []).includes(id)) }
      throw new Error(`unexpected ${String(low.fun)}`)
    }
    return { m, asked, call }
  }

  async function setup(m: Parameters<typeof master>[0]) {
    const opened = await openTestDatabase(dialect)
    close = opened.close
    const { db, schema } = opened
    const salt = master(m)
    let now = at(0)
    const collector = new MinionCollector({ db, schema, salt, now: () => now })
    return { db, schema, salt, collector, state: () => minionState(db, schema), setNow: (d: Date) => (now = d) }
  }

  const ret = (r: Partial<JobRet> & Pick<JobRet, 'jid' | 'minion' | 'fun'>): JobRet => ({ args: '[]', saltUser: null, shakerUser: null, ret: 'null', retcode: 0, success: true, summary: null, returnedAt: at(5), ...r })
  const DRY = '[{"__kwarg__":true,"test":true}]'

  it('keeps a row per accepted key with its trimmed grains, and drops deleted keys', async () => {
    const t = await setup({ accepted: ['web-01', 'db-01'], grains: { 'web-01': { os: 'Debian', pythonpath: ['/usr'], saltversion: '3007.1' }, 'db-01': 'no grains' } })
    await t.collector.collect()
    expect(await t.state()).toEqual({
      minions: {
        'web-01': { grains: { os: 'Debian', saltversion: '3007.1' }, up: null, compliance: null, updates: null },
        'db-01': { grains: null, up: null, compliance: null, updates: null },
      },
      statusAt: null,
    })
    expect(t.salt.asked).toEqual(['key.list_all', 'cache.grains'])

    // the cache lost web-01 (it keeps what it had), db-01 got grains, and a key was deleted and one added
    t.salt.m.accepted = ['web-01', 'cache-01']
    t.salt.m.grains = { 'cache-01': { os: 'Rocky' } }
    await t.collector.collect()
    const { minions } = await t.state()
    expect(Object.keys(minions).sort()).toEqual(['cache-01', 'web-01'])
    expect(minions['web-01'].grains).toEqual({ os: 'Debian', saltversion: '3007.1' })
    expect(minions['cache-01'].grains).toEqual({ os: 'Rocky' })
  })

  it('records who answers, from a round or from the presence check', async () => {
    const t = await setup({ accepted: ['a', 'b', 'c'], up: ['a'] })
    await t.collector.collect({ status: true })
    let s = await t.state()
    expect([s.minions.a.up, s.minions.b.up, s.minions.c.up]).toEqual([true, false, false])
    expect(s.statusAt).toEqual(at(0))

    await t.collector.recordStatus(['a', 'b'], ['c'], at(3))
    s = await t.state()
    expect([s.minions.a.up, s.minions.b.up, s.minions.c.up]).toEqual([true, true, false])
    expect(s.statusAt).toEqual(at(3))
  })

  it('marks a minion up as soon as it returns a job or starts', async () => {
    const t = await setup({ accepted: ['a', 'b', 'c'], up: [] })
    await t.collector.collect({ status: true })
    await t.collector.onReturn(ret({ jid: '1', minion: 'a', fun: 'cmd.run' }))
    t.collector.onEvent('salt/minion/b/start')
    t.collector.onEvent('salt/minion/b/starting')
    t.setNow(at(2))
    await t.collector.flushSeen()
    const s = await t.state()
    expect([s.minions.a.up, s.minions.b.up, s.minions.c.up]).toEqual([true, true, false])
  })

  it('marks a new minion up when it started before its key was read', async () => {
    const t = await setup({ accepted: ['a'], up: ['a'] })
    await t.collector.collect({ status: true })
    t.collector.onEvent('salt/minion/new-01/start')
    await t.collector.flushSeen()
    t.salt.m.accepted = ['a', 'new-01']
    await t.collector.collect()
    await t.collector.flushSeen()
    expect((await t.state()).minions['new-01'].up).toBe(true)
  })

  it('keeps the latest compliance check and patch scan of each minion as their returns come in', async () => {
    const t = await setup({ accepted: ['a', 'b'] })
    await t.collector.collect()
    await t.collector.onReturn(ret({ jid: '10', minion: 'a', fun: 'state.apply', args: DRY, summary: '{"ok":3,"changed":0,"pending":2,"failed":0}', returnedAt: at(5) }))
    await t.collector.onReturn(ret({ jid: '11', minion: 'b', fun: 'state.highstate', args: DRY, summary: '{"ok":3,"changed":0,"pending":0,"failed":0}', returnedAt: at(5) }))
    // a real apply is not a check, and an older check that arrives late doesn't replace a newer one
    await t.collector.onReturn(ret({ jid: '12', minion: 'a', fun: 'state.apply', args: '[]', summary: '{"ok":5,"changed":2,"pending":0,"failed":0}', returnedAt: at(6) }))
    await t.collector.onReturn(ret({ jid: '09', minion: 'a', fun: 'state.apply', args: DRY, summary: '{"ok":5,"changed":0,"pending":0,"failed":0}', returnedAt: at(4) }))
    await t.collector.onReturn(ret({ jid: '20', minion: 'a', fun: 'pkg.list_upgrades', ret: '{"nginx":"1.2","curl":"8"}', returnedAt: at(7) }))
    // a failed scan leaves the last good one
    await t.collector.onReturn(ret({ jid: '21', minion: 'a', fun: 'pkg.list_upgrades', ret: '"E: lock"', retcode: 1, returnedAt: at(8) }))
    // not an accepted minion: nothing to keep
    await t.collector.onReturn(ret({ jid: '20', minion: 'ghost', fun: 'pkg.list_upgrades', ret: '{}' }))

    const { minions } = await t.state()
    expect(minions.a.compliance).toEqual({ status: 'drift', jid: '10', checkedAt: at(5) })
    expect(minions.b.compliance).toEqual({ status: 'ok', jid: '11', checkedAt: at(5) })
    expect(minions.a.updates).toEqual({ packages: 2, jid: '20', checkedAt: at(7) })
    expect(minions.b.updates).toBeNull()
    expect(Object.keys(minions).sort()).toEqual(['a', 'b'])
  })

  it('fills in what history already knows about minions new to the table', async () => {
    const t = await setup({ accepted: ['a', 'b'] })
    await t.db.insert(t.schema.job).values([
      { jid: '1', fun: 'state.apply', dryRun: true, minions: '["a"]', startedAt: at(1) },
      { jid: '2', fun: 'pkg.list_upgrades', minions: '["a"]', startedAt: at(2) },
    ])
    await t.db.insert(t.schema.jobReturn).values([
      { jid: '1', minion: 'a', summary: '{"ok":1,"changed":0,"pending":0,"failed":1}', retcode: 2, success: false, returnedAt: at(1) },
      { jid: '2', minion: 'a', ret: '{"nginx":"1.2"}', retcode: 0, success: true, returnedAt: at(2) },
    ])
    await t.collector.collect()
    const { minions } = await t.state()
    expect(minions.a.compliance).toEqual({ status: 'error', jid: '1', checkedAt: at(1) })
    expect(minions.a.updates).toEqual({ packages: 1, jid: '2', checkedAt: at(2) })
    expect(minions.b).toEqual({ grains: null, up: null, compliance: null, updates: null })
  })

  it('runs one round at a time, and a refresh waits for one that also checks who answers', async () => {
    const t = await setup({ accepted: ['a'], up: ['a'] })
    await Promise.all([t.collector.collect(), t.collector.collect(), t.collector.collect({ status: true })])
    expect(t.salt.asked).toEqual(['key.list_all', 'cache.grains', 'key.list_all', 'cache.grains', 'manage.status'])
  })

  it('serves the fleet from the table, reading the master only when nothing was checked yet or on refresh', async () => {
    const t = await setup({ accepted: ['a'], grains: { a: { os: 'Debian' } }, up: ['a'] })
    const app = new Hono<Env>()
    let user: Env['Variables']['user'] = null
    app.use('*', async (c, next) => {
      c.set('user', user)
      await next()
    })
    app.route('/api', minionRoutes({ db: t.db, schema: t.schema, collector: t.collector, salt: t.salt }))
    expect((await app.request('/api/minions')).status).toBe(401)
    user = { id: 'u0', name: 'Nobody', role: 'none' } as Env['Variables']['user']
    expect((await app.request('/api/minions')).status).toBe(403)
    user = { id: 'u1', name: 'Vera', role: 'viewer' } as Env['Variables']['user']

    const first = await app.request('/api/minions')
    expect(await first.json()).toEqual({ minions: { a: { grains: { os: 'Debian' }, up: true, compliance: null, updates: null } }, statusAt: at(0).toISOString() })
    expect(t.salt.asked).toHaveLength(3)
    await app.request('/api/minions')
    expect(t.salt.asked).toHaveLength(3)

    t.salt.m.up = []
    const fresh = (await (await app.request('/api/minions/refresh', { method: 'POST' })).json()) as { minions: { a: { up: boolean } } }
    expect(fresh.minions.a.up).toBe(false)
    expect(t.salt.asked).toHaveLength(6)
  })
})
