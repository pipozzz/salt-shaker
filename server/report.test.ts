import { afterEach, describe, expect, it } from 'vitest'
import { isoWeek, reportDue, reportMessage, reportStats, WeeklyReport, type ReportStats } from './report'
import { openTestDatabase, testDialects } from './testdb'

const DAY = 86400_000

it('says how the week went in a few lines', () => {
  const s: ReportStats = {
    from: new Date(Date.UTC(2026, 10, 2, 12)),
    to: new Date(Date.UTC(2026, 10, 9, 12)),
    minions: { accepted: 42, notAnswering: 1, quiet: 1 },
    jobs: { run: 120, failed: 3 },
    changes: { done: 2, stopped: 1, waiting: 0 },
    vulns: { critical: 5, high: 12, fixable: 9, criticalBefore: 7, highBefore: 11 },
    commands: { count: 85, people: 4 },
  }
  expect(reportMessage(s)).toEqual({
    title: 'Weekly report: 42 minions, 3 failed jobs, 5 critical vulnerabilities',
    lines: [
      '2 Nov – 9 Nov',
      'Minions: 42 accepted, 1 not answering, 1 quiet for 30+ days',
      'Jobs: 120 run, 3 failed',
      'Changes: 2 rolled out, 1 stopped or failed',
      'Vulnerabilities: 5 critical (−2), 12 high (+1), 9 with a fix',
      'Commands from the console and API: 85, by 4 people',
    ],
    severity: 'warning',
    path: '/',
  })
  const quiet = reportMessage({ ...s, minions: { accepted: 1, notAnswering: 0, quiet: 0 }, jobs: { run: 0, failed: 0 }, changes: { done: 0, stopped: 0, waiting: 0 }, vulns: null, commands: { count: 1, people: 1 } })
  expect(quiet.title).toBe('Weekly report: 1 minion, 0 failed jobs')
  expect(quiet.lines).toEqual(['2 Nov – 9 Nov', 'Minions: 1 accepted', 'Jobs: 0 run, 0 failed', 'Commands from the console and API: 1, by 1 person'])
  expect(quiet.severity).toBe('info')
})

it('knows the week and when its report is due', () => {
  expect(isoWeek(new Date(2026, 10, 9, 9))).toBe('2026-W46')
  expect(isoWeek(new Date(2026, 10, 15, 23))).toBe('2026-W46')
  expect(isoWeek(new Date(2027, 0, 1))).toBe('2026-W53')
  expect(reportDue(new Date(2026, 10, 9, 7, 59))).toBe(false)
  expect(reportDue(new Date(2026, 10, 9, 8))).toBe(true)
  expect(reportDue(new Date(2026, 10, 15, 23))).toBe(true)
})

describe.each(testDialects)('weekly report (%s)', (dialect) => {
  let close: (() => Promise<unknown>) | null = null
  afterEach(async () => {
    await close?.()
    close = null
  })

  it('counts the week from what the server keeps', async () => {
    const opened = await openTestDatabase(dialect)
    close = opened.close
    const { db, schema } = opened
    const now = new Date(Date.UTC(2026, 10, 9, 8))
    const ago = (d: number) => new Date(+now - d * DAY)
    await db.insert(schema.minionSeen).values([
      { minion: 'web-01', lastSeenAt: ago(0) },
      { minion: 'db-01', lastSeenAt: ago(2) },
      { minion: 'old-01', lastSeenAt: ago(90) },
    ])
    await db.insert(schema.job).values([
      { jid: '1', fun: 'state.apply', startedAt: ago(1) },
      { jid: '2', fun: 'cmd.run', startedAt: ago(2) },
      { jid: '3', fun: 'cmd.run', startedAt: ago(10) },
    ])
    await db.insert(schema.jobReturn).values([
      { jid: '1', minion: 'web-01', retcode: 0, success: true, returnedAt: ago(1) },
      { jid: '2', minion: 'web-01', retcode: 1, success: false, returnedAt: ago(2) },
      { jid: '2', minion: 'db-01', retcode: 1, success: false, returnedAt: ago(2) },
      { jid: '3', minion: 'web-01', retcode: 1, success: false, returnedAt: ago(10) },
    ])
    const change = { reason: 'r', target: '*', targetType: 'glob', fun: 'state.apply', args: '[]', requestedBy: 'ada', requestedAt: ago(3) }
    await db.insert(schema.change).values([
      { ...change, status: 'done', finishedAt: ago(1) },
      { ...change, status: 'stopped', finishedAt: ago(2) },
      { ...change, status: 'done', finishedAt: ago(20) },
      { ...change, status: 'pending' },
    ])
    const vd = { medium: 0, low: 0, unknown: 0, minions: 3, affected: 2 }
    await db.insert(schema.vulnDaily).values([
      { day: '2026-10-30', critical: 9, high: 1, fixable: 1, ...vd },
      { day: '2026-11-01', critical: 7, high: 11, fixable: 5, ...vd },
      { day: '2026-11-08', critical: 5, high: 12, fixable: 9, ...vd },
    ])
    const audit = { userId: null, role: 'admin', outcome: 'ok' }
    await db.insert(schema.auditLog).values([
      { ...audit, at: ago(1), username: 'ada', client: 'local', fun: 'cmd.run' },
      { ...audit, at: ago(2), username: 'otto', client: 'runner', fun: 'jobs.list_jobs' },
      { ...audit, at: ago(2), username: 'ada', client: 'console', fun: 'keys.open_window' },
      { ...audit, at: ago(9), username: 'vera', client: 'local', fun: 'cmd.run' },
    ])
    const stats = await reportStats(db, schema, ['web-01', 'db-01', 'old-01', 'new-01'], now)
    expect(stats).toMatchObject({
      // new-01 hasn't answered since recording began 90 days ago
      minions: { accepted: 4, notAnswering: 3, quiet: 2 },
      jobs: { run: 2, failed: 1 },
      changes: { done: 1, stopped: 1, waiting: 1 },
      vulns: { critical: 5, high: 12, fixable: 9, criticalBefore: 7, highBefore: 11 },
      commands: { count: 2, people: 2 },
    })
  })

  it('goes out once a week, on Monday from 8:00, and not late in the week', async () => {
    const opened = await openTestDatabase(dialect)
    close = opened.close
    const { db, schema } = opened
    let now = new Date(2026, 10, 11, 10) // a Wednesday
    const sent: string[] = []
    const report = new WeeklyReport({ db, schema, accepted: async () => ['a'], send: async (m) => void sent.push(m.title), now: () => now })
    // started mid-week: marks the week without sending
    expect(await report.tick()).toBe(false)
    now = new Date(2026, 10, 16, 7, 50)
    expect(await report.tick()).toBe(false)
    now = new Date(2026, 10, 16, 8, 5)
    expect(await report.tick()).toBe(true)
    now = new Date(2026, 10, 16, 8, 15)
    expect(await report.tick()).toBe(false)
    expect(sent).toEqual(['Weekly report: 1 minion, 0 failed jobs'])
  })
})
