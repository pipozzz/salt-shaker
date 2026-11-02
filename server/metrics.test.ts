import { afterEach, describe, expect, it } from 'vitest'
import { collectMetrics, formatMetrics, keyCounts } from './metrics'
import type { SaltService } from './salt'
import { openTestDatabase, testDialects } from './testdb'

describe('formatMetrics', () => {
  it('writes the Prometheus text format with escaped labels', () => {
    const text = formatMetrics([
      { name: 'a_up', help: 'Up.', samples: [{ value: 1 }] },
      { name: 'b', help: 'By name.', samples: [{ labels: { name: 'say "hi"\\n' }, value: 2.5 }, { labels: { name: 'x' }, value: NaN }] },
    ])
    expect(text).toBe(['# HELP a_up Up.', '# TYPE a_up gauge', 'a_up 1', '# HELP b By name.', '# TYPE b gauge', 'b{name="say \\"hi\\"\\\\n"} 2.5', 'b{name="x"} NaN', ''].join('\n'))
  })
})

describe('keyCounts', () => {
  it('counts wheel key.list_all by status', () => {
    const res = { data: { return: { minions: ['a', 'b'], minions_pre: ['c'], minions_rejected: [], minions_denied: ['d'] }, success: true } }
    expect(keyCounts(res)).toEqual([
      { labels: { status: 'accepted' }, value: 2 },
      { labels: { status: 'pending' }, value: 1 },
      { labels: { status: 'rejected' }, value: 0 },
      { labels: { status: 'denied' }, value: 1 },
    ])
  })
})

describe.each(testDialects)('collectMetrics (%s)', (dialect) => {
  let close: (() => Promise<unknown>) | null = null
  afterEach(async () => {
    await close?.()
    close = null
  })
  const now = new Date('2026-11-02T12:00:00Z')
  const ago = (h: number) => new Date(now.getTime() - h * 3600_000)
  const summary = (s: object) => JSON.stringify({ ok: 0, changed: 0, pending: 0, failed: 0, ...s })

  async function setup() {
    const opened = await openTestDatabase(dialect)
    close = opened.close
    const { db, schema } = opened
    await db.insert(schema.job).values([
      { jid: '1', fun: 'state.apply', dryRun: true, minions: '["a","b","c"]', startedAt: ago(2) },
      { jid: '2', fun: 'cmd.run', minions: '["a"]', startedAt: ago(1) },
      { jid: '0', fun: 'state.apply', dryRun: true, minions: '["a"]', startedAt: ago(48) },
    ])
    await db.insert(schema.jobReturn).values([
      { jid: '1', minion: 'a', summary: summary({ ok: 3 }), retcode: 0, success: true, returnedAt: ago(2) },
      { jid: '1', minion: 'b', summary: summary({ pending: 1 }), retcode: 0, success: true, returnedAt: ago(2) },
      { jid: '2', minion: 'a', retcode: 1, success: true, returnedAt: ago(1) },
    ])
    await db.insert(schema.schedule).values([
      { name: 'nightly', kind: 'compliance', target: '*', targetType: 'glob', cron: '0 2 * * *', createdAt: ago(100), lastRunAt: ago(1), lastJid: '2' },
      { name: 'broken', kind: 'function', target: 'nope', targetType: 'glob', cron: '0 3 * * *', createdAt: ago(100), lastRunAt: ago(3), lastSummary: '{"error":"No minions matched the target"}' },
      { name: 'off', kind: 'patches', target: '*', targetType: 'glob', cron: '0 4 * * *', enabled: false, createdAt: ago(100) },
    ])
    return { db, schema }
  }

  const value = (text: string, series: string) => text.split('\n').find((l) => l.startsWith(`${series} `))?.split(' ')[1]

  it('reports keys, the latest compliance check, recent jobs and schedules', async () => {
    const { db, schema } = await setup()
    const salt = { call: async () => ({ data: { return: { minions: ['a', 'b', 'c'], minions_pre: ['d'] }, success: true } }) } as unknown as SaltService
    const text = formatMetrics(await collectMetrics({ db, schema, salt, version: '9.9.9', isLeader: true, now }))
    expect(value(text, 'salt_shaker_info{version="9.9.9"}')).toBe('1')
    expect(value(text, 'salt_shaker_master_up')).toBe('1')
    expect(value(text, 'salt_shaker_minion_keys{status="accepted"}')).toBe('3')
    expect(value(text, 'salt_shaker_minion_keys{status="pending"}')).toBe('1')
    // jid 1 is the latest dry run: a ok, b drifted, c never returned
    expect(value(text, 'salt_shaker_compliance_minions{status="ok"}')).toBe('1')
    expect(value(text, 'salt_shaker_compliance_minions{status="drift"}')).toBe('1')
    expect(value(text, 'salt_shaker_compliance_minions{status="noreturn"}')).toBe('1')
    expect(value(text, 'salt_shaker_compliance_last_check_timestamp_seconds')).toBe(String(ago(2).getTime() / 1000))
    expect(value(text, 'salt_shaker_jobs_24h')).toBe('2')
    expect(value(text, 'salt_shaker_job_returns_24h{result="failed"}')).toBe('1')
    expect(value(text, 'salt_shaker_job_returns_24h{result="ok"}')).toBe('2')
    expect(value(text, 'salt_shaker_schedule_enabled{schedule="off",kind="patches"}')).toBe('0')
    expect(value(text, 'salt_shaker_schedule_last_run_timestamp_seconds{schedule="off",kind="patches"}')).toBe('0')
    expect(value(text, 'salt_shaker_schedule_last_run_failed_minions{schedule="nightly",kind="compliance"}')).toBe('1')
    expect(value(text, 'salt_shaker_schedule_last_run_error{schedule="broken",kind="function"}')).toBe('1')
    expect(value(text, 'salt_shaker_schedule_last_run_error{schedule="nightly",kind="compliance"}')).toBe('0')
  })

  it('still answers when salt-api is down', async () => {
    const { db, schema } = await setup()
    const salt = { call: async () => Promise.reject(new Error('down')) } as unknown as SaltService
    const text = formatMetrics(await collectMetrics({ db, schema, salt, version: '1', isLeader: false, now }))
    expect(value(text, 'salt_shaker_master_up')).toBe('0')
    expect(value(text, 'salt_shaker_events_leader')).toBe('0')
    expect(text).not.toContain('salt_shaker_minion_keys')
    expect(value(text, 'salt_shaker_jobs_24h')).toBe('2')
  })
})
