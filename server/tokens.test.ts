import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { afterEach, describe, expect, it } from 'vitest'
import { openTestDatabase, testDialects } from './testdb'
import { tokenRoutes, userForToken } from './tokens'
import type { Env } from './types'

describe.each(testDialects)('API tokens (%s)', (dialect) => {
  let close: (() => Promise<unknown>) | null = null
  afterEach(async () => {
    await close?.()
    close = null
  })

  it('are made once, act as their user, and stop with them', async () => {
    const opened = await openTestDatabase(dialect)
    close = opened.close
    const { db, schema } = opened
    const now = new Date()
    await db.insert(schema.user).values({ id: 'u-olga', name: 'Olga', email: 'olga@x.invalid', username: 'olga', role: 'operator', createdAt: now, updatedAt: now })
    const audited: string[] = []
    const app = new Hono<Env>()
    app.use('*', async (c, next) => {
      c.set('user', { id: 'u-olga', name: 'Olga', username: 'olga', role: 'operator' })
      c.set('via', (c.req.header('x-via') as 'token' | undefined) ?? 'session')
      await next()
    })
    app.route('/api', tokenRoutes({ db, schema, audit: async (r) => void audited.push(`${r.fun} ${r.target}`) }))
    const call = async (method: string, path: string, body?: unknown, via?: string) => {
      const res = await app.request(`/api${path}`, { method, headers: { 'content-type': 'application/json', ...(via ? { 'x-via': via } : {}) }, body: body ? JSON.stringify(body) : undefined })
      return { status: res.status, body: (await res.json()) as Record<string, unknown> }
    }

    expect((await call('POST', '/tokens', { name: '' })).status).toBe(400)
    const made = await call('POST', '/tokens', { name: 'gitlab deploy', days: 30 })
    expect(made.status).toBe(201)
    const token = made.body.token as string
    expect(token).toMatch(/^ss_[\w-]{43}$/)
    // listed without the token or its hash
    const list = (await call('GET', '/tokens')).body.tokens as Array<Record<string, unknown>>
    expect(list).toMatchObject([{ name: 'gitlab deploy', prefix: token.slice(0, 10) }])
    expect(JSON.stringify(list)).not.toContain(token)
    expect(list[0].tokenHash).toBeUndefined()

    expect(await userForToken(db, schema, token)).toEqual({ id: 'u-olga', name: 'Olga', username: 'olga', role: 'operator' })
    expect(await userForToken(db, schema, 'ss_nope')).toBeNull()
    expect(await userForToken(db, schema, token, new Date(Date.now() + 31 * 86400_000))).toBeNull()
    const [row] = await db.select().from(schema.apiToken)
    expect(row.lastUsedAt).not.toBeNull()

    // a token can't make or list tokens
    expect((await call('POST', '/tokens', { name: 'x' }, 'token')).status).toBe(403)
    // disabled users' tokens stop working, and so do tokens of a user whose role is taken away
    await db.update(schema.user).set({ banned: true }).where(eq(schema.user.id, 'u-olga'))
    expect(await userForToken(db, schema, token)).toBeNull()
    await db.update(schema.user).set({ banned: false, role: 'none' }).where(eq(schema.user.id, 'u-olga'))
    expect(await userForToken(db, schema, token)).toBeNull()

    expect((await call('DELETE', `/tokens/${row.id}`)).status).toBe(200)
    expect((await call('DELETE', `/tokens/${row.id}`)).status).toBe(404)
    expect(audited).toEqual(['token.create gitlab deploy', 'token.delete gitlab deploy'])
  })
})
