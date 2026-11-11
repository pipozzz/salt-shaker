import { Hono } from 'hono'
import { afterEach, describe, expect, it } from 'vitest'
import { globMatch, KeyAutoAccept, keyRuleRoutes, specificEnough } from './keyrules'
import { openTestDatabase, testDialects } from './testdb'
import type { Env } from './types'

it('matches minion ids like globs, and wants patterns that name something', () => {
  expect(globMatch('web-2026-*', 'web-2026-07')).toBe(true)
  expect(globMatch('web-2026-*', 'db-2026-07')).toBe(false)
  expect(globMatch('web-0?', 'web-07')).toBe(true)
  expect(globMatch('web.lab', 'webXlab')).toBe(false)
  expect(['web-*', 'edge-ams-?'].every(specificEnough)).toBe(true)
  expect(['*', '*-*', 'a*b', 'web *'].some(specificEnough)).toBe(false)
})

describe.each(testDialects)('enrollment windows (%s)', (dialect) => {
  let close: (() => Promise<unknown>) | null = null
  afterEach(async () => {
    await close?.()
    close = null
  })

  it('accepts matching new keys while the window is open, up to its limit', async () => {
    const opened = await openTestDatabase(dialect)
    close = opened.close
    const { db, schema } = opened
    let now = Date.UTC(2026, 10, 11, 12)
    const calls: Array<Record<string, unknown>> = []
    const notes: string[] = []
    const audited: string[] = []
    const auto = new KeyAutoAccept({
      db,
      schema,
      salt: { call: async (low) => void calls.push(low) },
      notify: async (m) => void notes.push(m.title),
      audit: async (r) => void audited.push(`${r.username} ${r.fun} ${r.target} ${r.outcome}`),
      now: () => now,
    })
    await db.insert(schema.keyRule).values({ pattern: 'web-2026-*', expiresAt: new Date(now + 3600_000), maxAccepts: 2, accepted: '[]', createdBy: 'ada', createdAt: new Date(now) })
    const knock = (id: string) => auto.onEvent('salt/auth', { act: 'pend', id })

    await knock('db-2026-01') // not in the window
    await knock('web-2026-01')
    await knock('web-2026-01') // it knocks again before the accept lands: once is enough
    await knock('web-2026-02')
    await knock('web-2026-03') // over the limit
    await auto.onEvent('salt/auth', { act: 'accept', id: 'web-2026-04' })
    expect(calls).toEqual([
      { client: 'wheel', fun: 'key.accept', match: 'web-2026-01' },
      { client: 'wheel', fun: 'key.accept', match: 'web-2026-02' },
    ])
    expect(notes).toEqual(['Minion accepted by an enrollment window: web-2026-01', 'Minion accepted by an enrollment window: web-2026-02'])
    expect(audited).toEqual(['rule:web-2026-* key.accept web-2026-01 ok', 'rule:web-2026-* key.accept web-2026-02 ok'])

    // after it closes, nothing more
    await db.update(schema.keyRule).set({ maxAccepts: 10 })
    now += 2 * 3600_000
    await knock('web-2026-05')
    expect(calls).toHaveLength(2)
  })

  it('lets only admins open and close windows, within limits', async () => {
    const opened = await openTestDatabase(dialect)
    close = opened.close
    const { db, schema } = opened
    const app = new Hono<Env>()
    app.use('*', async (c, next) => {
      const [name, role] = (c.req.header('x-user') ?? '').split(':')
      c.set('user', name ? { id: name, name, username: name, role } : null)
      await next()
    })
    const audited: string[] = []
    app.route('/api', keyRuleRoutes({ db, schema, audit: async (r) => void audited.push(r.fun) }))
    const post = (user: string, path: string, body: unknown) => app.request(`/api${path}`, { method: 'POST', headers: { 'x-user': user, 'content-type': 'application/json' }, body: JSON.stringify(body) })

    expect((await post('olga:operator', '/key-rules', { pattern: 'web-*', hours: 2, maxAccepts: 5 })).status).toBe(403)
    expect((await post('ada:admin', '/key-rules', { pattern: '*', hours: 2, maxAccepts: 5 })).status).toBe(400)
    expect((await post('ada:admin', '/key-rules', { pattern: 'web-*', hours: 100, maxAccepts: 5 })).status).toBe(400)
    expect((await post('ada:admin', '/key-rules', { pattern: 'web-*', hours: 2, maxAccepts: 0 })).status).toBe(400)
    const made = await post('ada:admin', '/key-rules', { pattern: 'web-*', hours: 2, maxAccepts: 5 })
    expect(made.status).toBe(201)
    const { rule } = (await made.json()) as { rule: { id: number; accepted: string[]; createdBy: string } }
    expect(rule).toMatchObject({ accepted: [], createdBy: 'ada' })
    expect((await post('ada:admin', `/key-rules/${rule.id}/close`, {})).status).toBe(200)
    const [row] = await db.select().from(schema.keyRule)
    expect(+row.expiresAt).toBeLessThanOrEqual(Date.now())
    expect(audited).toEqual(['keys.open_window', 'keys.close_window'])
  })
})
