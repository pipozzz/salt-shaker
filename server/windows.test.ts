import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { afterEach, describe, expect, it } from 'vitest'
import type { Notifier } from './notify'
import type { SaltService } from './salt'
import { runsAt, Scheduler } from './scheduler'
import { openTestDatabase, testDialects } from './testdb'
import type { Env, SessionUser } from './types'
import { windowRoutes } from './windows'

const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6]
/** HH:MM in UTC, `minutes` from now */
const utcTime = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString().slice(11, 16)

describe.each(testDialects)('maintenance windows (%s)', (dialect) => {
  let close: (() => Promise<unknown>) | null = null
  afterEach(async () => {
    await close?.()
    close = null
  })

  it('everyone reads them, admins add and remove them, and removing one frees its schedules', async () => {
    const opened = await openTestDatabase(dialect)
    close = opened.close
    const { db, schema } = opened
    const audited: string[] = []
    let user: SessionUser | null = null
    const app = new Hono<Env>()
    app.use('*', async (c, next) => {
      c.set('user', user)
      await next()
    })
    // Friday 2026-11-13 12:00 UTC
    app.route('/api', windowRoutes({ db, schema, audit: async (r) => void audited.push(`${r.username} ${r.fun} ${r.target}`), now: () => Date.parse('2026-11-13T12:00:00Z') }))
    const add = (body: unknown) => app.request('/api/windows', { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } })
    const nights = { name: 'Nights', days: [2, 4], start: '22:00', minutes: 240, timezone: 'Europe/Bratislava' }

    expect((await app.request('/api/windows')).status).toBe(401)
    user = { id: 'v', name: 'Vic', username: 'vic', role: 'viewer' }
    expect((await add(nights)).status).toBe(403)

    user = { id: 'a', name: 'Ada', username: 'ada', role: 'admin' }
    expect(await (await add({ ...nights, days: [] })).json()).toEqual({ error: 'Pick at least one day' })
    const created = (await (await add(nights)).json()) as { window: { id: number } }
    expect((await add(nights)).status).toBe(400)
    expect(audited).toEqual(['ada window.add Nights'])

    user = { id: 'v', name: 'Vic', username: 'vic', role: 'viewer' }
    expect(await (await app.request('/api/windows')).json()).toEqual({
      windows: [{ id: created.window.id, ...nights }],
      open: null,
      next: { id: created.window.id, start: '2026-11-17T21:00:00.000Z', end: '2026-11-18T01:00:00.000Z' },
    })

    const [s] = await db
      .insert(schema.schedule)
      .values({ name: 'patch', kind: 'function', fun: 'test.ping', target: '*', targetType: 'glob', cron: '0 3 * * *', createdAt: new Date(), windowId: created.window.id })
      .returning()
    user = { id: 'a', name: 'Ada', username: 'ada', role: 'admin' }
    expect((await app.request(`/api/windows/${created.window.id}`, { method: 'DELETE' })).status).toBe(200)
    const [after] = await db.select().from(schema.schedule).where(eq(schema.schedule.id, s.id))
    expect(after.windowId).toBeNull()
    expect(audited.at(-1)).toBe('ada window.remove Nights')
  })

  it('a schedule tied to a window waits for it to open', async () => {
    const opened = await openTestDatabase(dialect)
    close = opened.close
    const { db, schema } = opened
    const [closedNow, openNow] = await db
      .insert(schema.maintenanceWindow)
      .values([
        { name: 'later', days: JSON.stringify(EVERY_DAY), start: utcTime(120), minutes: 15, timezone: 'UTC', createdAt: new Date() },
        { name: 'now', days: JSON.stringify(EVERY_DAY), start: utcTime(-60), minutes: 120, timezone: 'UTC', createdAt: new Date() },
      ])
      .returning()
    const due = { cron: '* * * * *', target: '*', targetType: 'glob', kind: 'function', fun: 'test.ping', createdAt: new Date(Date.now() - 3600_000) }
    await db.insert(schema.schedule).values([
      { ...due, name: 'waits', windowId: closedNow.id },
      { ...due, name: 'runs', windowId: openNow.id },
      { ...due, name: 'free' },
    ])
    const ran: string[] = []
    const salt = { call: async (low: { metadata: { salt_shaker_user: string } }) => (ran.push(low.metadata.salt_shaker_user), { jid: `j${ran.length}`, minions: ['a'] }) } as unknown as SaltService
    const sch = new Scheduler(db, schema, salt, { emit: async () => undefined } as unknown as Notifier, async () => undefined)
    await sch.tick()
    expect(ran.sort()).toEqual(['schedule:free', 'schedule:runs'])

    // and it says when it'll run: when the window opens, not at its cron slot
    const [waits] = await db.select().from(schema.schedule).where(eq(schema.schedule.name, 'waits'))
    const window = { id: closedNow.id, name: 'later', days: EVERY_DAY, start: closedNow.start, minutes: 15, timezone: 'UTC' }
    const at = runsAt(waits, window)!
    expect(at.toISOString().slice(11, 16)).toBe(closedNow.start)
    expect(+at).toBeGreaterThan(Date.now())
  })
})
