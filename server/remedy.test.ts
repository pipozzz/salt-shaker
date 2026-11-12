import { eq } from 'drizzle-orm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Notifier } from './notify'
import type { SaltService } from './salt'
import { readRemedy, Scheduler } from './scheduler'
import { openTestDatabase, testDialects } from './testdb'

it('reads a remedy, or none', () => {
  expect(readRemedy(null)).toBeNull()
  expect(readRemedy('nope')).toBeNull()
  expect(readRemedy('{"batchSize":" 25% ","maxFailures":1}')).toEqual({ batchSize: '25%', maxFailures: 1 })
  expect(readRemedy('{"batchSize":"","maxFailures":-3}')).toEqual({ batchSize: null, maxFailures: 0 })
})

const summary = (x: object) => JSON.stringify({ ok: 3, changed: 0, pending: 0, failed: 0, ...x })
const EVERY_DAY = JSON.stringify([0, 1, 2, 3, 4, 5, 6])
const utcTime = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString().slice(11, 16)

describe.each(testDialects)('fixing drift (%s)', (dialect) => {
  let close: (() => Promise<unknown>) | null = null
  afterEach(async () => {
    await close?.()
    close = null
  })

  it('a compliance schedule with a remedy fixes the drifted minions with a change, once at a time, and only in its window', async () => {
    const opened = await openTestDatabase(dialect)
    close = opened.close
    const { db, schema } = opened
    let n = 0
    const salt = { call: async () => ({ jid: `c${++n}`, minions: ['web-01', 'web-02', 'db-01', 'cache-01'] }) } as unknown as SaltService
    const emitted: Array<{ event: string; lines: string[] }> = []
    const notifier = { emit: async (event: string, msg: { lines: string[] }) => void emitted.push({ event, lines: msg.lines }) } as unknown as Notifier
    const audited: string[] = []
    const sch = new Scheduler(db, schema, salt, notifier, async (r) => void audited.push(`${r.username} ${r.fun} ${r.target}`))
    const [s] = await db
      .insert(schema.schedule)
      .values({ name: 'nightly', kind: 'compliance', target: '*', targetType: 'glob', cron: '0 0 1 1 *', createdAt: new Date(), remedy: JSON.stringify({ batchSize: '50%', maxFailures: 1 }) })
      .returning()

    // web-02 and web-01 drifted, db-01 has errors (left for a person), cache-01 is fine
    const check = async () => {
      const jid = (await sch.run(s))!
      await db.insert(schema.jobReturn).values([
        { jid, minion: 'web-02', summary: summary({ pending: 2 }), success: true, retcode: 0, returnedAt: new Date() },
        { jid, minion: 'web-01', summary: summary({ pending: 1 }), success: true, retcode: 0, returnedAt: new Date() },
        { jid, minion: 'db-01', summary: summary({ failed: 1 }), success: false, retcode: 2, returnedAt: new Date() },
        { jid, minion: 'cache-01', summary: summary({}), success: true, retcode: 0, returnedAt: new Date() },
      ])
      await sch.tick()
      return jid
    }

    const jid = await check()
    const changes = await db.select().from(schema.change)
    expect(changes).toHaveLength(1)
    expect(changes[0]).toMatchObject({ target: 'web-01,web-02', targetType: 'list', fun: 'state.apply', batchSize: '50%', maxFailures: 1, status: 'queued', requestedBy: 'schedule:nightly' })
    expect(changes[0].reason).toBe(`Fix the drift that "nightly" found (job ${jid})`)
    expect(audited).toContain(`schedule:nightly change.request #${changes[0].id} state.apply → web-01,web-02`)
    await vi.waitFor(async () => {
      const [after] = await db.select().from(schema.schedule).where(eq(schema.schedule.id, s.id))
      expect(JSON.parse(after.lastSummary!)).toMatchObject({ drift: 2, error: 1, remedyChange: changes[0].id, remedyMinions: 2 })
    })
    expect(emitted.find((e) => e.event === 'drift')!.lines).toContain(`Fixing 2 drifted minions in change #${changes[0].id}`)

    // the next check doesn't start another fix while that one hasn't finished
    await check()
    expect(await db.select().from(schema.change)).toHaveLength(1)
    expect(emitted.filter((e) => e.event === 'drift').at(-1)!.lines).toContain(`Not fixed: its last fix, change #${changes[0].id}, hasn't finished`)

    // and nothing starts once its window has closed
    await db.update(schema.change).set({ status: 'done' })
    const [w] = await db.insert(schema.maintenanceWindow).values({ name: 'Nights', days: EVERY_DAY, start: utcTime(120), minutes: 15, timezone: 'UTC', createdAt: new Date() }).returning()
    await db.update(schema.schedule).set({ windowId: w.id }).where(eq(schema.schedule.id, s.id))
    s.windowId = w.id
    await check()
    expect(await db.select().from(schema.change)).toHaveLength(1)
    expect(emitted.filter((e) => e.event === 'drift').at(-1)!.lines).toContain('Not fixed: the window Nights has closed')
  })
})
