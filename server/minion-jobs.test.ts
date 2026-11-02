import { afterEach, describe, expect, it } from 'vitest'
import { latestCompliance, minionJobs } from './minion-jobs'
import { openTestDatabase, testDialects } from './testdb'

describe.each(testDialects)('minionJobs (%s)', (dialect) => {
  let close: (() => Promise<unknown>) | null = null
  afterEach(async () => {
    await close?.()
    close = null
  })
  const at = (m: number) => new Date(Date.UTC(2026, 10, 2, 12, m))

  async function setup() {
    const opened = await openTestDatabase(dialect)
    close = opened.close
    const { db, schema } = opened
    await db.insert(schema.job).values([
      { jid: '1', fun: 'state.apply', dryRun: true, minions: '["web_01","web-01"]', startedAt: at(1) },
      { jid: '2', fun: 'cmd.run', minions: '["web-01"]', startedAt: at(2) },
      // no minion list (recorded from a return only)
      { jid: '3', fun: 'pkg.upgrade', startedAt: at(3) },
      { jid: '4', fun: 'test.ping', minions: '["db-01"]', startedAt: at(4) },
      { jid: '5', fun: 'grains.get', minions: '["webx01"]', startedAt: at(5) },
    ])
    await db.insert(schema.jobReturn).values([
      { jid: '1', minion: 'web_01', summary: '{"ok":1,"changed":0,"pending":2,"failed":0}', retcode: 0, success: true, returnedAt: at(1) },
      { jid: '1', minion: 'web-01', summary: '{"ok":3,"changed":0,"pending":0,"failed":0}', retcode: 0, success: true, returnedAt: at(1) },
      { jid: '3', minion: 'web_01', retcode: 1, success: true, returnedAt: at(3) },
      { jid: '4', minion: 'db-01', retcode: 0, success: true, returnedAt: at(4) },
    ])
    return { db, schema }
  }

  it("lists jobs that targeted the minion or got its return, with the minion's own result", async () => {
    const { db, schema } = await setup()
    const rows = await minionJobs(db, schema, 'web_01')
    // '_' must not match '-' or 'x', so jobs 2 and 5 stay out
    expect(rows.map((r) => [r.jid, r.retcode, r.summary])).toEqual([
      ['3', 1, null],
      ['1', 0, '{"ok":1,"changed":0,"pending":2,"failed":0}'],
    ])
    const other = await minionJobs(db, schema, 'web-01')
    expect(other.map((r) => [r.jid, r.returnedAt === null])).toEqual([
      ['2', true],
      ['1', false],
    ])
  })

  it('pages by start time', async () => {
    const { db, schema } = await setup()
    expect((await minionJobs(db, schema, 'web_01', { limit: 1 })).map((r) => r.jid)).toEqual(['3'])
    expect((await minionJobs(db, schema, 'web_01', { before: at(3).getTime() })).map((r) => r.jid)).toEqual(['1'])
  })
})

describe.each(testDialects)('latestCompliance (%s)', (dialect) => {
  let close: (() => Promise<unknown>) | null = null
  afterEach(async () => {
    await close?.()
    close = null
  })
  const at = (m: number) => new Date(Date.UTC(2026, 10, 2, 12, m))
  const sum = (s: object) => JSON.stringify({ ok: 1, changed: 0, pending: 0, failed: 0, ...s })

  it("keeps each minion's newest compliance result", async () => {
    const opened = await openTestDatabase(dialect)
    close = opened.close
    const { db, schema } = opened
    expect(await latestCompliance(db, schema)).toEqual({})
    await db.insert(schema.job).values([
      { jid: '1', fun: 'state.apply', dryRun: true, minions: '["a","b","c"]', startedAt: at(1) },
      // b did not return from the newer check, so its older result stays
      { jid: '2', fun: 'state.highstate', dryRun: true, minions: '["a","b"]', startedAt: at(2) },
      // not a compliance check
      { jid: '3', fun: 'state.apply', dryRun: false, minions: '["a"]', startedAt: at(3) },
    ])
    await db.insert(schema.jobReturn).values([
      { jid: '1', minion: 'a', summary: sum({ pending: 1 }), retcode: 0, success: true, returnedAt: at(1) },
      { jid: '1', minion: 'b', summary: sum({ failed: 1 }), retcode: 2, success: true, returnedAt: at(1) },
      { jid: '1', minion: 'c', summary: sum({}), retcode: 0, success: true, returnedAt: at(1) },
      { jid: '2', minion: 'a', summary: sum({}), retcode: 0, success: true, returnedAt: at(2) },
      { jid: '3', minion: 'a', summary: sum({ failed: 1 }), retcode: 2, success: true, returnedAt: at(3) },
    ])
    expect(await latestCompliance(db, schema)).toEqual({
      a: { status: 'ok', jid: '2', checkedAt: at(2) },
      b: { status: 'error', jid: '1', checkedAt: at(1) },
      c: { status: 'ok', jid: '1', checkedAt: at(1) },
    })
    // only the newest check is looked at
    expect(Object.keys(await latestCompliance(db, schema, 1))).toEqual(['a'])
  })
})
