import { Hono } from 'hono'
import { afterEach, describe, expect, it } from 'vitest'
import { peerRoutes, peerUrl, summarize, type Summary } from './peers'
import { openTestDatabase, testDialects } from './testdb'
import type { Env, SessionUser } from './types'

it('takes only plain http(s) addresses for other instances', () => {
  expect(peerUrl(' https://salt-eu.example.com/ ')).toBe('https://salt-eu.example.com')
  expect(peerUrl('https://example.com/salt/')).toBe('https://example.com/salt')
  expect(peerUrl('ftp://example.com')).toBeNull()
  expect(peerUrl('https://user:pw@example.com')).toBeNull()
  expect(peerUrl('https://example.com/?x=1')).toBeNull()
  expect(peerUrl('not a url')).toBeNull()
})

const other: Summary = { name: 'prod-us', version: '1.20.0', url: 'https://salt-us.example.com', minions: { accepted: 40, notAnswering: 2 }, pendingKeys: 1, failedJobs: 3, vulns: { critical: 4, high: 9 }, waitingApproval: 0 }

describe.each(testDialects)('instances (%s)', (dialect) => {
  let close: (() => Promise<unknown>) | null = null
  afterEach(async () => {
    await close?.()
    close = null
  })

  it('sums an instance up from what it keeps', async () => {
    const opened = await openTestDatabase(dialect)
    close = opened.close
    const { db, schema } = opened
    const now = Date.UTC(2026, 10, 11, 12)
    await db.insert(schema.minionSeen).values([
      { minion: 'a', lastSeenAt: new Date(now - 60_000) },
      { minion: 'b', lastSeenAt: new Date(now - 5 * 3600_000) },
    ])
    await db.insert(schema.job).values([
      { jid: '1', fun: 'cmd.run', startedAt: new Date(now - 3600_000) },
      { jid: '2', fun: 'cmd.run', startedAt: new Date(now - 48 * 3600_000) },
    ])
    await db.insert(schema.jobReturn).values([
      { jid: '1', minion: 'a', retcode: 1, success: false, returnedAt: new Date(now) },
      { jid: '2', minion: 'a', retcode: 1, success: false, returnedAt: new Date(now) },
    ])
    await db.insert(schema.vulnDaily).values({ day: '2026-11-11', critical: 2, high: 5, medium: 0, low: 0, unknown: 0, fixable: 3, minions: 2, affected: 1 })
    await db.insert(schema.change).values({ reason: 'r', target: '*', targetType: 'glob', fun: 'state.apply', args: '[]', status: 'pending', requestedBy: 'olga', requestedAt: new Date(now) })
    const s = await summarize({ db, schema, name: 'prod-eu', version: '1.20.0', url: 'https://salt-eu.example.com', keys: async () => ({ accepted: ['a', 'b', 'c'], pending: 2 }) }, now)
    expect(s).toEqual({
      name: 'prod-eu',
      version: '1.20.0',
      url: 'https://salt-eu.example.com',
      minions: { accepted: 3, notAnswering: 2 },
      pendingKeys: 2,
      failedJobs: 1,
      vulns: { critical: 2, high: 5 },
      waitingApproval: 1,
    })
  })

  it('lets admins add instances that answer, and shows everyone how they are doing', async () => {
    const opened = await openTestDatabase(dialect)
    close = opened.close
    const { db, schema } = opened
    const audited: string[] = []
    const requests: Array<{ url: string; auth: string | null }> = []
    const fakeFetch = (async (url: string, init?: RequestInit) => {
      requests.push({ url, auth: new Headers(init?.headers).get('authorization') })
      if (url.startsWith('https://salt-us.example.com')) return new Response(JSON.stringify(other), { status: 200 })
      if (url.startsWith('https://old.example.com')) return new Response('{}', { status: 401 })
      throw new Error('getaddrinfo ENOTFOUND')
    }) as typeof fetch
    let user: SessionUser | null = null
    const app = new Hono<Env>()
    app.use('*', async (c, next) => {
      c.set('user', user)
      await next()
    })
    app.route('/api', peerRoutes({ db, schema, audit: async (r) => void audited.push(`${r.username} ${r.fun} ${r.target}`), self: async () => ({ ...other, name: 'prod-eu' }), fetch: fakeFetch }))
    const add = (body: unknown) => app.request('/api/peers', { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } })

    expect((await app.request('/api/summary')).status).toBe(401)
    user = { id: 'v', name: 'Vic', username: 'vic', role: 'viewer' }
    expect(await (await app.request('/api/summary')).json()).toMatchObject({ name: 'prod-eu' })
    expect((await add({ name: 'US', url: 'https://salt-us.example.com', token: 'ss_x' })).status).toBe(403)

    user = { id: 'a', name: 'Ada', username: 'ada', role: 'admin' }
    expect(await (await add({ name: 'US', url: 'https://salt-us.example.com', token: 'nope' })).json()).toMatchObject({ error: expect.stringContaining('ss_') })
    expect(await (await add({ name: 'Old', url: 'https://old.example.com', token: 'ss_old' })).json()).toMatchObject({ error: expect.stringContaining('token was refused') })
    const ok = await add({ name: 'prod-us', url: 'https://salt-us.example.com/', token: 'ss_us' })
    expect(ok.status).toBe(200)
    expect(requests.at(-1)).toEqual({ url: 'https://salt-us.example.com/api/summary', auth: 'Bearer ss_us' })
    expect(audited).toEqual(['ada peer.add prod-us (https://salt-us.example.com)'])

    // a peer that stops answering shows why, the others still show
    await db.insert(schema.peer).values({ name: 'lab', url: 'https://lab.invalid', token: 'ss_lab', createdAt: new Date() })
    user = { id: 'v', name: 'Vic', username: 'vic', role: 'viewer' }
    const list = (await (await app.request('/api/peers')).json()) as { peers: Array<Record<string, unknown>> }
    expect(list.peers.map((p) => p.name)).toEqual(['lab', 'prod-us'])
    expect(list.peers.every((p) => !('token' in p))).toBe(true)
    const status = (await (await app.request('/api/peers/status')).json()) as { peers: Array<{ name: string; summary?: Summary; error?: string }> }
    expect(status.peers).toEqual([
      { id: expect.any(Number), name: 'lab', url: 'https://lab.invalid', error: 'Unreachable: getaddrinfo ENOTFOUND' },
      { id: expect.any(Number), name: 'prod-us', url: 'https://salt-us.example.com', summary: other },
    ])
  })
})
