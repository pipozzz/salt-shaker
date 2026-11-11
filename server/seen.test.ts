import { Hono } from 'hono'
import { afterEach, describe, expect, it } from 'vitest'
import { lastSeen, recordSeen, seenRoutes } from './seen'
import { openTestDatabase, testDialects } from './testdb'
import type { Env } from './types'

describe.each(testDialects)('last seen (%s)', (dialect) => {
  let close: (() => Promise<unknown>) | null = null
  afterEach(async () => {
    await close?.()
    close = null
  })

  it('keeps each minion’s latest answer, and since when answers are kept', async () => {
    const opened = await openTestDatabase(dialect)
    close = opened.close
    const { db, schema } = opened
    expect(await lastSeen(db, schema)).toEqual({ seen: {}, since: null })
    const t0 = new Date(Date.UTC(2026, 8, 1))
    const t1 = new Date(Date.UTC(2026, 10, 11))
    await recordSeen(db, schema, ['web-01', 'old-01'], t0)
    await recordSeen(db, schema, ['web-01'], t1)
    expect(await lastSeen(db, schema)).toEqual({ seen: { 'web-01': t1.toISOString(), 'old-01': t0.toISOString() }, since: t0.toISOString() })

    // many at once go in chunks
    const ids = Array.from({ length: 1201 }, (_, i) => `m-${i}`)
    await recordSeen(db, schema, ids, t1)
    expect(Object.keys((await lastSeen(db, schema)).seen)).toHaveLength(1203)

    const app = new Hono<Env>()
    let user: Env['Variables']['user'] = null
    app.use('*', async (c, next) => {
      c.set('user', user)
      await next()
    })
    app.route('/api', seenRoutes({ db, schema, checking: true }))
    expect((await app.request('/api/minions/seen')).status).toBe(401)
    user = { id: 'u1', name: 'Vera', role: 'viewer' } as Env['Variables']['user']
    const res = await app.request('/api/minions/seen')
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ checking: true, since: t0.toISOString(), seen: { 'old-01': t0.toISOString() } })
  })
})
