import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { HistoryRecorder, isDryRun, parseJobEvent, takeSseData } from './history'
import { openTestDatabase, testDialects } from './testdb'

// shapes captured from salt-api's /events on Salt 3007
const newEvent = {
  _stamp: '2026-11-01T19:11:51.725580',
  arg: ['common', { __kwarg__: true, test: true }],
  fun: 'state.apply',
  jid: '20261101191151725177',
  minions: ['web-01'],
  missing: [],
  tgt: 'web-01',
  tgt_type: 'glob',
  user: 'shaker',
}
const retEvent = {
  _stamp: '2026-11-01T19:11:52.101000',
  cmd: '_return',
  fun: 'state.apply',
  fun_args: ['common', { __kwarg__: true, test: true }],
  id: 'web-01',
  jid: '20261101191151725177',
  metadata: { salt_shaker_user: 'otto' },
  out: 'highstate',
  retcode: 0,
  return: {
    'file_|-motd_|-/etc/motd_|-managed': { result: null, changes: { diff: '…' }, comment: 'would change', __run_num__: 0 },
    'pkg_|-tools_|-tools_|-installed': { result: true, changes: {}, comment: 'ok', __run_num__: 1 },
  },
  success: true,
  user: 'shaker',
}

describe('parseJobEvent', () => {
  it('reads a new job', () => {
    const p = parseJobEvent('salt/job/20261101191151725177/new', newEvent)
    expect(p).toMatchObject({ kind: 'new', job: { jid: '20261101191151725177', fun: 'state.apply', target: 'web-01', saltUser: 'shaker', dryRun: true } })
    if (p?.kind === 'new') {
      expect(JSON.parse(p.job.minions)).toEqual(['web-01'])
      expect(p.job.startedAt.toISOString()).toBe('2026-11-01T19:11:51.725Z')
    }
  })

  it('reads a return with its state summary and the Salt Shaker user', () => {
    const p = parseJobEvent('salt/job/20261101191151725177/ret/web-01', retEvent)
    expect(p).toMatchObject({ kind: 'ret', ret: { minion: 'web-01', shakerUser: 'otto', retcode: 0, success: true } })
    if (p?.kind === 'ret') expect(JSON.parse(p.ret.summary!)).toEqual({ ok: 1, changed: 0, pending: 1, failed: 0 })
  })

  it('keeps minion ids that contain slashes or dots', () => {
    const p = parseJobEvent('salt/job/20261101191151725177/ret/edge/lon.01', retEvent)
    expect(p?.kind === 'ret' && p.ret.minion).toBe('edge/lon.01')
  })

  it('skips noise and non-job events', () => {
    expect(parseJobEvent('salt/job/20261101191151725177/new', { ...newEvent, fun: 'saltutil.find_job' })).toBeNull()
    expect(parseJobEvent('salt/job/20261101191151725177/new', { ...newEvent, fun: 'grains.items' })).toBeNull()
    expect(parseJobEvent('salt/job/20261101191151725177/ret/web-01', { ...retEvent, fun: 'runner.jobs.list_jobs' })).toBeNull()
    expect(parseJobEvent('salt/auth', { id: 'x', act: 'pend' })).toBeNull()
    expect(parseJobEvent('salt/job/20261101191151725177/publish', newEvent)).toBeNull()
    expect(parseJobEvent('20261101191151725177', newEvent)).toBeNull()
  })

  it('keeps returns of noisy functions that a schedule ran', () => {
    const ping = { ...retEvent, fun: 'test.ping', return: true, metadata: { salt_shaker_user: 'schedule:ping all' } }
    const p = parseJobEvent('salt/job/20261101191151725177/ret/web-01', ping)
    expect(p?.kind === 'ret' && p.ret.shakerUser).toBe('schedule:ping all')
    // the same function run by a person stays out
    expect(parseJobEvent('salt/job/20261101191151725177/ret/web-01', { ...ping, metadata: { salt_shaker_user: 'otto' } })).toBeNull()
  })

  it('stores huge returns as a marker', () => {
    const p = parseJobEvent('salt/job/20261101191151725177/ret/web-01', { ...retEvent, return: 'x'.repeat(600 * 1024) })
    expect(p?.kind === 'ret' && JSON.parse(p.ret.ret)).toMatchObject({ _truncated: true })
  })
})

describe('isDryRun', () => {
  it('detects test=True among job arguments', () => {
    expect(isDryRun(['common', { __kwarg__: true, test: true }])).toBe(true)
    expect(isDryRun(['common', { __kwarg__: true, test: false }])).toBe(false)
    expect(isDryRun(['test=True'])).toBe(false)
    expect(isDryRun(null)).toBe(false)
  })
})

describe('takeSseData', () => {
  it('returns complete frames and keeps the partial rest', () => {
    const { payloads, rest } = takeSseData('retry: 400\n\ntag: a\ndata: {"x":1}\n\ntag: b\ndata: {"y"')
    expect(payloads).toEqual(['{"x":1}'])
    expect(rest).toBe('tag: b\ndata: {"y"')
  })
})

describe.each(testDialects)('HistoryRecorder storage (%s)', (dialect) => {
  let opened: Awaited<ReturnType<typeof openTestDatabase>>
  let rec: HistoryRecorder
  beforeAll(async () => {
    opened = await openTestDatabase(dialect)
    rec = new HistoryRecorder(opened.db, opened.schema, { subscribe: () => () => undefined }, 30)
  })
  afterAll(() => opened.close())

  const jobs = (jid: string) => opened.db.select().from(opened.schema.job).where(eq(opened.schema.job.jid, jid))
  const returns = (jid: string) => opened.db.select().from(opened.schema.jobReturn).where(eq(opened.schema.jobReturn.jid, jid))

  it('stores a job and its returns, updating a repeated return', async () => {
    await rec.record('salt/job/20261101191151725177/new', newEvent)
    await rec.record('salt/job/20261101191151725177/new', newEvent)
    await rec.record('salt/job/20261101191151725177/ret/web-01', retEvent)
    await rec.record('salt/job/20261101191151725177/ret/web-01', { ...retEvent, retcode: 2 })
    const [j] = await jobs('20261101191151725177')
    expect(j).toMatchObject({ fun: 'state.apply', target: 'web-01', dryRun: true, shakerUser: 'otto' })
    const r = await returns('20261101191151725177')
    expect(r).toHaveLength(1)
    expect(r[0]).toMatchObject({ minion: 'web-01', retcode: 2, success: true })
  })

  it('counts on the job how many minions returned and failed, following repeated returns', async () => {
    const jid = '20261119080000000001'
    const counts = async () => (await jobs(jid)).map((j) => [j.returned, j.failed])[0]
    await rec.record(`salt/job/${jid}/new`, { ...newEvent, jid })
    expect(await counts()).toEqual([0, 0])
    await rec.record(`salt/job/${jid}/ret/web-01`, { ...retEvent, jid })
    await rec.record(`salt/job/${jid}/ret/web-02`, { ...retEvent, jid, id: 'web-02', retcode: 2 })
    await rec.record(`salt/job/${jid}/ret/web-03`, { ...retEvent, jid, id: 'web-03', success: false })
    expect(await counts()).toEqual([3, 2])
    // the same minions again: one now fails, one no longer does
    await rec.record(`salt/job/${jid}/ret/web-01`, { ...retEvent, jid, retcode: 1 })
    await rec.record(`salt/job/${jid}/ret/web-02`, { ...retEvent, jid, id: 'web-02' })
    await rec.record(`salt/job/${jid}/ret/web-03`, { ...retEvent, jid, id: 'web-03', success: false })
    expect(await counts()).toEqual([3, 2])
  })

  it('creates the job from a return when the new event was missed', async () => {
    await rec.record('salt/job/20261101191151999999/ret/web-02', { ...retEvent, jid: '20261101191151999999', id: 'web-02' })
    const [j] = await jobs('20261101191151999999')
    expect(j).toMatchObject({ fun: 'state.apply', dryRun: true, minions: '["web-02"]', shakerUser: 'otto' })
  })

  it('stores events from masters that stamp them with a time zone', async () => {
    // newer Salt sends _stamp as an aware UTC time ("…+00:00"); it used to become an invalid date
    const jid = '20261118124914123456'
    await rec.record(`salt/job/${jid}/new`, { ...newEvent, jid, _stamp: '2026-11-18T12:49:14.123456+00:00' })
    await rec.record(`salt/job/${jid}/ret/web-01`, { ...retEvent, jid, _stamp: '2026-11-18T12:49:15.500000+00:00' })
    const [j] = await jobs(jid)
    expect(j.startedAt.toISOString()).toBe('2026-11-18T12:49:14.123Z')
    const [r] = await returns(jid)
    expect(r.returnedAt.toISOString()).toBe('2026-11-18T12:49:15.500Z')
  })

  it('writes a batch of events as they would be written one by one', async () => {
    const jid = '20261120090000000001'
    const missed = '20261120090000000002'
    const minions = Array.from({ length: 1200 }, (_, i) => `app-${String(i).padStart(4, '0')}`)
    const seen: string[] = []
    const batchRec = new HistoryRecorder(opened.db, opened.schema, { subscribe: () => () => undefined }, 30)
    batchRec.onReturn((r) => seen.push(`${r.jid}/${r.minion}`))
    const early = '20261120090000000004'
    await batchRec.record(`salt/job/${jid}/new`, { ...newEvent, jid, minions, tgt: 'app-*' })
    await batchRec.record(`salt/job/${jid}/ret/app-0000`, { ...retEvent, jid, id: 'app-0000' })
    await batchRec.recordAll([
      [`salt/job/${jid}/ret/app-0001`, { ...retEvent, jid, id: 'app-0001', retcode: 1 }],
      // a return before its job's "new" in the same batch: the "new" still describes the job
      [`salt/job/${early}/ret/db-02`, { ...retEvent, jid: early, id: 'db-02' }],
      [`salt/job/${early}/new`, { ...newEvent, jid: early, minions: ['db-02'], tgt: 'db-*' }],
      ...minions.slice(2).map((m, i): [string, Record<string, unknown>] => [`salt/job/${jid}/ret/${m}`, { ...retEvent, jid, id: m, success: i % 100 !== 0 }]),
      // app-0000 again (already stored, now failing) and app-0001 twice in the batch (the last wins)
      [`salt/job/${jid}/ret/app-0000`, { ...retEvent, jid, id: 'app-0000', retcode: 3 }],
      [`salt/job/${jid}/ret/app-0001`, { ...retEvent, jid, id: 'app-0001' }],
      [`salt/job/${missed}/ret/db-01`, { ...retEvent, jid: missed, id: 'db-01', metadata: {} }],
      ['salt/job/20261120090000000003/new', { ...newEvent, fun: 'test.ping' }],
    ])
    const [j] = await jobs(jid)
    // 1198 returns failing every 100th (12), app-0000 failing, app-0001 not
    expect(j).toMatchObject({ target: 'app-*', returned: 1200, failed: 13, shakerUser: 'otto' })
    const stored = await returns(jid)
    expect(stored).toHaveLength(1200)
    expect(stored.find((r) => r.minion === 'app-0000')).toMatchObject({ retcode: 3 })
    expect(stored.find((r) => r.minion === 'app-0001')).toMatchObject({ retcode: 0 })
    expect(await jobs(missed)).toMatchObject([{ minions: '["db-01"]', returned: 1, shakerUser: null }])
    expect(await jobs(early)).toMatchObject([{ target: 'db-*', returned: 1 }])
    // app-0000 alone, then every distinct return of the batch once
    expect(seen).toHaveLength(1 + 1200 + 2)
  })

  it('records events that arrive while a write is under way together, and the rest of a batch that fails', async () => {
    let listener: (e: { tag: string; data: Record<string, unknown> }) => void = () => undefined
    const busRec = new HistoryRecorder(opened.db, opened.schema, { subscribe: (fn) => ((listener = fn as typeof listener), () => undefined) }, 30)
    const batches: number[] = []
    const write = busRec.recordAll.bind(busRec)
    let failOnce = true
    busRec.recordAll = async (events, notify) => {
      batches.push(events.length)
      if (failOnce && events.length > 1) {
        failOnce = false
        throw new Error('the database blinked')
      }
      return write(events, notify)
    }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    busRec.start()
    const jid = '20261120090000000010'
    listener({ tag: `salt/job/${jid}/new`, data: { ...newEvent, jid } })
    for (let i = 0; i < 50; i++) listener({ tag: `salt/job/${jid}/ret/m-${i}`, data: { ...retEvent, jid, id: `m-${i}` } })
    await vi.waitFor(async () => expect((await jobs(jid))[0]?.returned).toBe(50))
    busRec.stop()
    warn.mockRestore()
    // the first event alone, the 50 that came meanwhile in one batch, which failed and was redone one by one
    expect(batches.slice(0, 2)).toEqual([1, 50])
    expect(batches.length).toBe(2 + 50)
  })

  it('prunes jobs past the retention window with their returns', async () => {
    const old = { ...newEvent, jid: '20200101000000000000', _stamp: '2020-01-01T00:00:00.000000' }
    await rec.record('salt/job/20200101000000000000/new', old)
    await rec.record('salt/job/20200101000000000000/ret/web-01', { ...retEvent, jid: old.jid, _stamp: old._stamp })
    await rec.prune()
    expect(await jobs(old.jid)).toHaveLength(0)
    expect(await returns(old.jid)).toHaveLength(0)
    expect(await jobs('20261101191151725177')).toHaveLength(1)
  })
})

describe.each(testDialects)('HistoryRecorder catching up (%s)', (dialect) => {
  // shapes from salt-run jobs.list_jobs / jobs.list_job on Salt 3007
  const listed = (fun: string, extra: Record<string, unknown> = {}) => ({ Function: fun, Arguments: ['echo hi'], Target: 'web-*', 'Target-type': 'glob', User: 'root', ...extra })
  const detail = (jid: string, fun: string, result: Record<string, unknown>) => ({ jid, ...listed(fun), Minions: Object.keys(result), Result: result })

  function setup(opened: Awaited<ReturnType<typeof openTestDatabase>>, cache: () => Record<string, Record<string, unknown>>) {
    let bus = { fn: (_e: { tag: string; data: Record<string, unknown> }) => undefined as void, lost: () => undefined as void, connected: () => undefined as void }
    const calls: string[] = []
    const salt = {
      call: async (low: Record<string, unknown>) => {
        calls.push(low.fun === 'jobs.list_job' ? `list_job ${(low.arg as string[])[0]}` : String(low.fun))
        const jobs = cache()
        if (low.fun === 'jobs.list_jobs') return Object.fromEntries(Object.entries(jobs).map(([jid, d]) => [jid, { ...d, Minions: undefined, Result: undefined }]))
        return jobs[(low.arg as string[])[0]] ?? {}
      },
    }
    const rec = new HistoryRecorder(
      opened.db,
      opened.schema,
      {
        subscribe: (fn, lost, connected) => {
          bus = { fn: fn as typeof bus.fn, lost: lost!, connected: connected! }
          return () => undefined
        },
      },
      30,
      0,
      salt,
    )
    const notified: string[] = []
    rec.onReturn((r) => notified.push(r.jid))
    rec.onEvent((tag) => notified.push(tag))
    return { rec, bus: () => bus, calls, notified }
  }

  it('records the jobs that ran while the stream was down, without notifying anyone', async () => {
    const opened = await openTestDatabase(dialect)
    const { job, jobReturn } = opened.schema
    const before = '20261125090000000000'
    // a job recorded before the gap, complete
    await opened.db.insert(job).values({ jid: before, fun: 'cmd.run', args: '[]', minions: '["web-01"]', returned: 1, startedAt: new Date('2026-11-25T09:00:00Z') })
    const cache: Record<string, Record<string, unknown>> = {
      '20261125080000000000': detail('20261125080000000000', 'cmd.run', { 'web-01': { return: 'old', retcode: 0, success: true } }),
      [before]: detail(before, 'cmd.run', { 'web-01': { return: 'hi', retcode: 0, success: true } }),
      '20261125091500000000': detail('20261125091500000000', 'cmd.run', { 'web-01': { return: 'hi', retcode: 0, success: true }, 'web-02': { return: 'boom', retcode: 1, success: false } }),
      '20261125091600000000': detail('20261125091600000000', 'test.ping', { 'web-01': { return: true, retcode: 0, success: true } }),
      '20261125091700000000': { ...detail('20261125091700000000', 'state.apply', { 'db-01': { return: { 'file_|-x_|-/x_|-managed': { result: true, changes: {} } }, retcode: 0, success: true } }), Metadata: { salt_shaker_user: 'ann' } },
    }
    const { rec, bus, calls, notified } = setup(opened, () => cache)
    rec.start()
    bus().connected()
    await vi.waitFor(() => expect(calls).toContain('list_job 20261125091700000000'))
    await rec.catchUp()

    // only what came after the newest recorded job, and no noise
    expect(calls).toEqual(['jobs.list_jobs', 'list_job 20261125091500000000', 'list_job 20261125091700000000'])
    const [missed] = await opened.db.select().from(job).where(eq(job.jid, '20261125091500000000'))
    expect(missed).toMatchObject({ fun: 'cmd.run', target: 'web-*', saltUser: 'root', returned: 2, failed: 1, startedAt: new Date('2026-11-25T09:15:00Z') })
    expect(await opened.db.select({ minion: jobReturn.minion, ret: jobReturn.ret, retcode: jobReturn.retcode }).from(jobReturn).where(eq(jobReturn.jid, '20261125091500000000')).orderBy(jobReturn.minion)).toEqual([
      { minion: 'web-01', ret: '"hi"', retcode: 0 },
      { minion: 'web-02', ret: '"boom"', retcode: 1 },
    ])
    const [state] = await opened.db.select().from(job).where(eq(job.jid, '20261125091700000000'))
    expect(state.shakerUser).toBe('ann')
    expect(notified).toEqual([])

    // the stream breaks after a live job; what ran meanwhile is read once it's back
    const live = '20261125100000000000'
    bus().fn({ tag: `salt/job/${live}/new`, data: { ...newEvent, jid: live, _stamp: '2026-11-25T09:00:00.000000' } })
    await vi.waitFor(async () => expect(await opened.db.select().from(job).where(eq(job.jid, live))).toHaveLength(1))
    bus().lost()
    cache['20261125100500000000'] = detail('20261125100500000000', 'cmd.run', { 'web-01': { return: 'later', retcode: 0, success: true } })
    calls.length = 0
    bus().connected()
    await vi.waitFor(() => expect(calls).toContain('list_job 20261125100500000000'))
    await rec.catchUp()
    expect(calls).toEqual(['jobs.list_jobs', 'list_job 20261125100500000000'])
    // the master's jids are an hour ahead of UTC (learnt from the live job's stamp)
    const [later] = await opened.db.select().from(job).where(eq(job.jid, '20261125100500000000'))
    expect(later.startedAt).toEqual(new Date('2026-11-25T09:05:00Z'))
    rec.stop()
    await opened.close()
  })

  it('starts history now on an empty database instead of reading the whole job cache', async () => {
    const opened = await openTestDatabase(dialect)
    const { rec, bus, calls } = setup(opened, () => ({ '20261125091500000000': detail('20261125091500000000', 'cmd.run', {}) }))
    rec.start()
    bus().connected()
    await rec.catchUp()
    expect(calls).toEqual([])
    rec.stop()
    await opened.close()
  })
})
