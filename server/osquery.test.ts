import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Notifier } from './notify'
import { osqueryDiff, osqueryMessage } from './osquery'
import type { SaltService } from './salt'
import { lowstateFor, Scheduler } from './scheduler'
import { automationRoutes } from './routes/automation'
import { openTestDatabase, testDialects } from './testdb'
import type { Env } from './types'

// what job_return.ret holds for a cmd.run of osqueryi: the JSON-encoded output string
const ret = (rows: object[]) => JSON.stringify(JSON.stringify(rows))
const missing = JSON.stringify("ERROR: Unable to run command '['osqueryi', '--json']', reason: [Errno 2] No such file or directory: 'osqueryi'")

describe('osqueryDiff', () => {
  const deploy = { username: 'deploy', shell: '/bin/bash' }
  const tmp = { username: 'tmpadmin', shell: '/bin/bash' }

  it('takes the first run as the baseline', () => {
    const d = osqueryDiff(null, [{ minion: 'web-01', ret: ret([deploy]) }], 1)
    expect(d).toMatchObject({ baseline: true, minions: 1, rows: 1, added: 0, removed: 0 })
    expect(osqueryMessage('users', '*', d, 'j1')).toMatchObject({ title: 'Query "users": first run, 1 row on 1 minion', severity: 'info' })
  })

  it('reports rows that appeared or went away, per minion', () => {
    const before = [
      { minion: 'web-01', ret: ret([deploy]) },
      { minion: 'web-02', ret: ret([deploy]) },
      { minion: 'db-01', ret: ret([deploy]) },
    ]
    const now = [
      { minion: 'web-01', ret: ret([deploy]) },
      // the same row with its keys in another order is the same row
      { minion: 'web-02', ret: ret([deploy, tmp].map((r) => Object.fromEntries(Object.entries(r).reverse()))) },
      { minion: 'db-01', ret: ret([]) },
      // a new minion has nothing to compare with
      { minion: 'web-03', ret: ret([tmp]) },
      { minion: 'mon-01', ret: missing },
      { minion: 'big-01', ret: JSON.stringify({ _truncated: true, bytes: 600_000 }) },
    ]
    const d = osqueryDiff(before, now, 7)
    expect(d).toEqual({
      baseline: false,
      minions: 4,
      rows: 4,
      added: 1,
      removed: 1,
      changedMinions: 2,
      missing: 1,
      failed: 0,
      tooLarge: 1,
      noreturn: 1,
      examples: ['web-02: + shell=/bin/bash username=tmpadmin', 'db-01: − shell=/bin/bash username=deploy'],
    })
    expect(osqueryMessage('users', 'web-*', d, 'j2')).toEqual({
      title: 'Query "users": 1 new, 1 gone on 2 minions',
      lines: ['Target: web-*', 'web-02: + shell=/bin/bash username=tmpadmin', 'db-01: − shell=/bin/bash username=deploy', 'osquery is not installed on 1 minion', 'The result on 1 minion is too large to compare (over 512 KB); narrow the query', '1 minion did not return'],
      severity: 'warning',
      path: '/jobs/j2',
    })
  })

  it('says so when nothing changed', () => {
    const rows = [{ minion: 'a', ret: ret([deploy]) }]
    expect(osqueryMessage('users', '*', osqueryDiff(rows, rows, 1), 'j').title).toBe('Query "users": no changes on 1 minion')
  })
})

describe.each(testDialects)('scheduled osquery queries (%s)', (dialect) => {
  let opened: Awaited<ReturnType<typeof openTestDatabase>>
  beforeAll(async () => {
    opened = await openTestDatabase(dialect)
  })
  afterAll(async () => {
    await opened.close()
  })

  it('runs osqueryi with the SQL on stdin', () => {
    expect(lowstateFor({ id: 1, name: 'ports', kind: 'osquery', fun: null, args: JSON.stringify({ sql: 'SELECT port FROM listening_ports' }), target: '*', targetType: 'glob' })).toMatchObject({
      fun: 'cmd.run',
      arg: ['osqueryi --json'],
      kwarg: { stdin: 'SELECT port FROM listening_ports;', python_shell: false },
    })
  })

  it('alerts when a run differs from the previous one, not on the first', async () => {
    const { db, schema } = opened
    const [s] = await db
      .insert(schema.schedule)
      .values({ name: 'ports', kind: 'osquery', args: JSON.stringify({ sql: 'SELECT port FROM listening_ports' }), target: '*', targetType: 'glob', cron: '0 0 1 1 *', createdAt: new Date() })
      .returning()
    let n = 0
    const salt = { call: async () => ({ jid: `2026111000000000000${++n}`, minions: ['web-01'] }) } as unknown as SaltService
    const emitted: Array<{ event: string; title: string }> = []
    const notifier = { emit: async (event: string, m: { title: string }) => void emitted.push({ event, title: m.title }) } as unknown as Notifier
    const sch = new Scheduler(db, schema, salt, notifier, async () => undefined)

    const runOnce = async (rows: object[]) => {
      const jid = (await sch.run(s))!
      await db.insert(schema.jobReturn).values({ jid, minion: 'web-01', ret: ret(rows), retcode: 0, success: true, returnedAt: new Date() })
      await sch.tick()
      const [done] = await db.select().from(schema.schedule).where(eq(schema.schedule.id, s.id))
      return JSON.parse(done.lastSummary!) as { baseline: boolean; added: number }
    }
    expect(await runOnce([{ port: '22' }])).toMatchObject({ baseline: true })
    // jobs are told apart by start time; make sure the second one is later
    await new Promise((r) => setTimeout(r, 5))
    expect(await runOnce([{ port: '22' }, { port: '8000' }])).toMatchObject({ baseline: false, added: 1 })
    expect(emitted).toEqual([
      { event: 'schedule', title: 'Query "ports": first run, 1 row on 1 minion' },
      { event: 'osquery', title: 'Query "ports": 1 new on 1 minion' },
      { event: 'schedule', title: 'Query "ports": 1 new on 1 minion' },
    ])
  })

  it('takes one SELECT as the schedule, and nothing else', async () => {
    const app = new Hono<Env>()
    app.use('*', async (c, next) => {
      c.set('user', { id: 'ada', name: 'ada', username: 'ada', role: 'admin' })
      await next()
    })
    const notifier = { emit: async () => undefined } as unknown as Notifier
    app.route('/api', automationRoutes({ ...opened, scheduler: {} as Scheduler, notifier, audit: async () => undefined }))
    const post = (args: unknown) =>
      app.request('/api/schedules', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: `q${Math.random()}`, kind: 'osquery', target: '*', targetType: 'glob', cron: '0 * * * *', args }) })
    expect((await post({ sql: 'DELETE FROM users' })).status).toBe(400)
    expect((await post({ sql: 'SELECT 1; SELECT 2' })).status).toBe(400)
    expect((await post(null)).status).toBe(400)
    const ok = await post({ sql: 'SELECT username FROM users' })
    expect(ok.status).toBe(200)
    const { schedule } = (await ok.json()) as { schedule: { args: string } }
    expect(JSON.parse(schedule.args)).toEqual({ sql: 'SELECT username FROM users' })
  })
})
