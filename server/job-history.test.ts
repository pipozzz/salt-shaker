import { afterEach, describe, expect, it } from 'vitest'
import { jobHistory } from './job-history'
import { openTestDatabase, testDialects } from './testdb'

describe.each(testDialects)('jobHistory (%s)', (dialect) => {
  let close: (() => Promise<unknown>) | null = null
  afterEach(async () => {
    await close?.()
    close = null
  })
  const at = (m: number) => new Date(Date.UTC(2026, 10, 5, 12, m))

  async function setup() {
    const opened = await openTestDatabase(dialect)
    close = opened.close
    const { db, schema } = opened
    await db.insert(schema.job).values([
      { jid: '1', fun: 'state.apply', dryRun: true, target: 'web*', shakerUser: 'alice', minions: '["a","b"]', startedAt: at(1) },
      { jid: '2', fun: 'cmd.run', target: 'db*', shakerUser: 'bob', minions: '["a","b"]', startedAt: at(2) },
      { jid: '3', fun: 'pkg.upgrade', target: '*', saltUser: 'root', minions: '["a"]', startedAt: at(3) },
      { jid: '4', fun: 'state.apply', target: 'web*', shakerUser: 'alice', minions: '["a"]', startedAt: at(4) },
    ])
    await db.insert(schema.jobReturn).values([
      { jid: '1', minion: 'a', retcode: 0, success: true, returnedAt: at(1) },
      { jid: '1', minion: 'b', retcode: 2, success: true, returnedAt: at(1) },
      { jid: '2', minion: 'a', retcode: 0, success: true, returnedAt: at(2) },
      { jid: '2', minion: 'b', retcode: 0, success: true, returnedAt: at(2) },
      { jid: '3', minion: 'a', retcode: 0, success: false, returnedAt: at(3) },
    ])
    return opened
  }

  it('lists jobs newest first with returned and failed counts', async () => {
    const { db, schema } = await setup()
    const rows = await jobHistory(db, schema)
    expect(rows.map((r) => [r.jid, r.returned, r.failed])).toEqual([
      ['4', 0, 0],
      ['3', 1, 1],
      ['2', 2, 0],
      ['1', 2, 1],
    ])
  })

  it('keeps only jobs where a minion failed, or only dry runs, together with the search and paging', async () => {
    const { db, schema } = await setup()
    expect((await jobHistory(db, schema, { result: 'failed' })).map((r) => r.jid)).toEqual(['3', '1'])
    expect((await jobHistory(db, schema, { result: 'failed', q: 'alice' })).map((r) => r.jid)).toEqual(['1'])
    expect((await jobHistory(db, schema, { result: 'failed', before: at(3).getTime() })).map((r) => r.jid)).toEqual(['1'])
    expect((await jobHistory(db, schema, { result: 'dryrun' })).map((r) => r.jid)).toEqual(['1'])
  })
})
