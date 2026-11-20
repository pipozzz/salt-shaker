import { afterEach, describe, expect, it } from 'vitest'
import { fleetFailures } from './failures'
import { openTestDatabase, testDialects } from './testdb'

const SVC = 'service_|-nginx_|-nginx_|-running'
const state = (result: boolean, comment = '') => JSON.stringify({ [SVC]: { __run_num__: 0, __sls__: 'webserver', result, comment, changes: {} } })

describe.each(testDialects)('fleetFailures (%s)', (dialect) => {
  let close: (() => Promise<unknown>) | null = null
  afterEach(async () => {
    await close?.()
    close = null
  })
  const now = Date.UTC(2026, 10, 20, 12)
  const hoursAgo = (h: number) => new Date(now - h * 3600_000)

  it('groups what still fails in the recent state runs, and reads only the minions that failed', async () => {
    const opened = await openTestDatabase(dialect)
    close = opened.close
    const { db, schema } = opened
    await db.insert(schema.job).values([
      { jid: '1', fun: 'state.apply', args: '[]', minions: '["web-01","web-02","web-03"]', startedAt: hoursAgo(5) },
      { jid: '2', fun: 'state.apply', args: '["webserver"]', minions: '["web-02"]', startedAt: hoursAgo(2) },
      { jid: '3', fun: 'state.apply', args: '["webserver.tls"]', minions: '["web-01"]', startedAt: hoursAgo(1) },
      // not a state run, and one too old to count
      { jid: '4', fun: 'cmd.run', args: '["false"]', minions: '["web-01"]', startedAt: hoursAgo(1) },
      { jid: '5', fun: 'state.apply', args: '[]', minions: '["web-04"]', startedAt: hoursAgo(30) },
    ])
    const failed = '{"ok":0,"changed":0,"pending":0,"failed":1}'
    await db.insert(schema.jobReturn).values([
      { jid: '1', minion: 'web-01', ret: state(false, 'Job for nginx.service failed.'), summary: failed, retcode: 2, success: true, returnedAt: hoursAgo(5) },
      { jid: '1', minion: 'web-02', ret: state(false, 'Job for nginx.service failed.'), summary: failed, retcode: 2, success: true, returnedAt: hoursAgo(5) },
      { jid: '1', minion: 'web-03', ret: state(true), summary: '{"ok":1,"changed":0,"pending":0,"failed":0}', retcode: 0, success: true, returnedAt: hoursAgo(5) },
      // fixed since
      { jid: '2', minion: 'web-02', ret: state(true), summary: '{"ok":1,"changed":0,"pending":0,"failed":0}', retcode: 0, success: true, returnedAt: hoursAgo(2) },
      { jid: '3', minion: 'web-01', ret: JSON.stringify(["No matching sls found for 'webserver.tls' in env 'base'"]), retcode: 1, success: true, returnedAt: hoursAgo(1) },
      { jid: '4', minion: 'web-01', ret: '""', retcode: 1, success: true, returnedAt: hoursAgo(1) },
      { jid: '5', minion: 'web-04', ret: state(false, 'old'), summary: failed, retcode: 2, success: true, returnedAt: hoursAgo(30) },
    ])

    const out = await fleetFailures(db, schema, { hours: 24, now })
    expect(out.runs).toBe(3)
    expect(out.capped).toBe(false)
    expect(out.groups.map((g) => [g.kind, g.label, g.message, g.minions.map((m) => `${m.id}@${m.jid}`)])).toEqual([
      ['run', 'state.apply webserver.tls', "No matching sls found for 'webserver.tls' in env 'base'", ['web-01@3']],
      ['state', 'service.running nginx', 'Job for nginx.service failed.', ['web-01@1']],
    ])
    expect((await fleetFailures(db, schema, { hours: 48, now })).groups.map((g) => g.message)).toContain('old')
  })
})
