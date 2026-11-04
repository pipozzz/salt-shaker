import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { payloadFor } from './notify'
import { maskUrl } from './routes/automation'
import type { Notifier } from './notify'
import type { SaltService } from './salt'
import { dueAt, lowstateFor, nextRun, Scheduler } from './scheduler'
import { openTestDatabase, testDialects } from './testdb'
import { complianceCounts, complianceMessage, failureSummary, patchSummary } from './summaries'

const sum = (s: object | null) => ({ summary: s ? JSON.stringify(s) : null })

describe('summaries', () => {
  it('buckets compliance returns like the Compliance page', () => {
    const c = complianceCounts(
      [sum({ ok: 3, changed: 0, pending: 0, failed: 0 }), sum({ ok: 2, changed: 0, pending: 1, failed: 0 }), sum({ ok: 1, changed: 0, pending: 0, failed: 1 }), sum(null)],
      6,
    )
    expect(c).toEqual({ ok: 1, drift: 1, error: 2, noreturn: 2 })
  })

  it('aggregates patch scans by package', () => {
    const p = patchSummary(
      [{ ret: JSON.stringify({ openssl: '3.1', tzdata: '2026f' }) }, { ret: JSON.stringify({ tzdata: '2026f' }) }, { ret: JSON.stringify({}) }, { ret: JSON.stringify('error') }],
      5,
    )
    expect(p).toMatchObject({ scanned: 4, needUpdates: 2, packages: 2, noreturn: 1 })
    expect(p.top[0]).toEqual(['tzdata', 2])
  })

  it('lists failed minions', () => {
    const f = failureSummary(
      [
        { minion: 'a', retcode: 0, success: true },
        { minion: 'b', retcode: 2, success: true },
        { minion: 'c', retcode: null, success: false },
      ],
      4,
    )
    expect(f).toEqual({ returned: 3, failed: ['b', 'c'], noreturn: 1 })
  })

  it('words compliance results by severity', () => {
    expect(complianceMessage('n', '*', { ok: 3, drift: 0, error: 0, noreturn: 0 }, '1').severity).toBe('info')
    expect(complianceMessage('n', '*', { ok: 2, drift: 1, error: 0, noreturn: 0 }, '1').severity).toBe('warning')
    expect(complianceMessage('n', '*', { ok: 2, drift: 0, error: 1, noreturn: 0 }, '1')).toMatchObject({ severity: 'error', path: '/jobs/1' })
  })
})

describe('notification payloads', () => {
  const msg = { title: 'cmd.run failed on 2 minions', lines: ['Minions: a, b'], severity: 'error' as const, path: '/jobs/1' }

  it('uses Slack incoming-webhook format with a link back', () => {
    expect(payloadFor('slack', 'job_failed', msg, 'https://salt.example.com')).toEqual({
      text: '🔴 *cmd.run failed on 2 minions*\nMinions: a, b\n<https://salt.example.com/jobs/1|Open in Salt Shaker>',
    })
  })

  it('sends an Adaptive Card to Microsoft Teams workflows', () => {
    const body = payloadFor('teams', 'job_failed', msg, 'https://salt.example.com') as { type: string; attachments: { contentType: string; content: { body: unknown[]; actions: unknown[] } }[] }
    expect(body.type).toBe('message')
    expect(body.attachments[0]!.contentType).toBe('application/vnd.microsoft.card.adaptive')
    expect(body.attachments[0]!.content.body).toEqual([
      { type: 'TextBlock', text: 'cmd.run failed on 2 minions', wrap: true, weight: 'Bolder', size: 'Medium', color: 'Attention' },
      { type: 'TextBlock', text: 'Minions: a, b', wrap: true, spacing: 'Small' },
    ])
    expect(body.attachments[0]!.content.actions).toEqual([{ type: 'Action.OpenUrl', title: 'Open in Salt Shaker', url: 'https://salt.example.com/jobs/1' }])
  })

  it('sends structured JSON to generic webhooks', () => {
    expect(payloadFor('webhook', 'job_failed', msg, 'https://salt.example.com')).toMatchObject({
      source: 'salt-shaker',
      event: 'job_failed',
      severity: 'error',
      url: 'https://salt.example.com/jobs/1',
    })
  })

  it('masks webhook secrets for display', () => {
    expect(maskUrl('https://hooks.slack.com/services/T000/B000/XXXXsecretYYYY')).toBe('https://hooks.slack.com/…YYYY')
    expect(maskUrl('not a url')).toBe('…')
  })
})

describe('scheduler', () => {
  it('rejects invalid cron expressions', () => {
    expect(() => nextRun('every day')).toThrow()
    expect(nextRun('0 2 * * *', new Date(2026, 10, 1, 12, 0))).toEqual(new Date(2026, 10, 2, 2, 0))
  })

  it('is due one slot after the last run, or after creation', () => {
    const createdAt = new Date(2026, 10, 1, 12, 0)
    expect(dueAt({ cron: '0 * * * *', lastRunAt: null, createdAt })).toEqual(new Date(2026, 10, 1, 13, 0))
    expect(dueAt({ cron: '0 * * * *', lastRunAt: new Date(2026, 10, 1, 13, 0, 5), createdAt })).toEqual(new Date(2026, 10, 1, 14, 0))
  })

  it('builds the lowstate for each kind and tags it with the schedule', () => {
    const base = { id: 7, name: 'nightly', fun: null, args: null, target: 'web-*', targetType: 'glob' }
    expect(lowstateFor({ ...base, kind: 'compliance' })).toMatchObject({
      client: 'local_async',
      fun: 'state.apply',
      kwarg: { test: true },
      metadata: { salt_shaker_user: 'schedule:nightly', salt_shaker_schedule: 7 },
    })
    expect(lowstateFor({ ...base, kind: 'patches' })).toMatchObject({ fun: 'pkg.list_upgrades', kwarg: { refresh: true } })
    expect(lowstateFor({ ...base, kind: 'function', fun: 'saltutil.sync_all', args: JSON.stringify({ arg: [], kwarg: { refresh: true } }) })).toMatchObject({
      fun: 'saltutil.sync_all',
      kwarg: { refresh: true },
    })
  })
})

describe.each(testDialects)('scheduler storage (%s)', (dialect) => {
  let opened: Awaited<ReturnType<typeof openTestDatabase>>
  beforeAll(async () => {
    opened = await openTestDatabase(dialect)
  })
  afterAll(() => opened.close())

  it('starts a due run on one instance only and summarizes it once the minions return', async () => {
    const { db, schema } = opened
    const [s] = await db
      .insert(schema.schedule)
      .values({ name: 'nightly', kind: 'compliance', target: '*', targetType: 'glob', cron: '* * * * *', createdAt: new Date(Date.now() - 3600_000) })
      .returning()
    const calls: unknown[] = []
    const salt = { call: async (low: unknown) => (calls.push(low), { jid: 'j1', minions: ['web-01', 'web-02'] }) } as unknown as SaltService
    const emitted: string[] = []
    const notifier = { emit: async (event: string) => void emitted.push(event) } as unknown as Notifier
    const audit = async () => undefined
    const a = new Scheduler(db, schema, salt, notifier, audit)
    const b = new Scheduler(db, schema, salt, notifier, audit)

    await Promise.all([a.tick(), b.tick()])
    expect(calls).toHaveLength(1)
    const [after] = await db.select().from(schema.schedule).where(eq(schema.schedule.id, s.id))
    expect(after.lastJid).toBe('j1')
    expect(after.lastRunAt).not.toBeNull()

    const summary = (x: object) => JSON.stringify({ ok: 1, changed: 0, pending: 0, failed: 0, ...x })
    await db.insert(schema.jobReturn).values([
      { jid: 'j1', minion: 'web-01', summary: summary({}), retcode: 0, success: true, returnedAt: new Date() },
      { jid: 'j1', minion: 'web-02', summary: summary({ pending: 2 }), retcode: 0, success: true, returnedAt: new Date() },
    ])
    await Promise.all([a.tick(), b.tick()])
    const [done] = await db.select().from(schema.schedule).where(eq(schema.schedule.id, s.id))
    expect(JSON.parse(done.lastSummary!)).toEqual({ ok: 1, drift: 1, error: 0, noreturn: 0 })
    expect(emitted.sort()).toEqual(['drift', 'schedule'])
    expect(calls).toHaveLength(1)
  })
})
