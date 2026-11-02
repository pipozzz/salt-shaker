import { afterEach, describe, expect, it } from 'vitest'
import { minionJobs } from './minion-jobs'
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
