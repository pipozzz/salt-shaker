import { createHmac } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { afterEach, describe, expect, it } from 'vitest'
import { isSlackResponseUrl, linkCode, parseCommand, readLinkCode, slackRoutes, targetType, verifySlack, words, type SaltAs } from './slack'
import { openTestDatabase, testDialects } from './testdb'
import type { Env, SessionUser } from './types'

const SECRET = 'slack-signing-secret'
const sig = (ts: number, body: string, secret = SECRET) => `v0=${createHmac('sha256', secret).update(`v0:${ts}:${body}`).digest('hex')}`

it('accepts only recent requests signed with the secret', () => {
  const now = 1_800_000_000_000
  const ts = now / 1000
  expect(verifySlack(SECRET, String(ts), 'a=1', sig(ts, 'a=1'), now)).toBe(true)
  expect(verifySlack(SECRET, String(ts), 'a=2', sig(ts, 'a=1'), now)).toBe(false)
  expect(verifySlack(SECRET, String(ts), 'a=1', sig(ts, 'a=1', 'other'), now)).toBe(false)
  expect(verifySlack(SECRET, String(ts - 600), 'a=1', sig(ts - 600, 'a=1'), now)).toBe(false)
  expect(verifySlack(SECRET, undefined, 'a=1', sig(ts, 'a=1'), now)).toBe(false)
})

it('makes link codes that expire and can’t be forged', () => {
  const now = 1_800_000_000_000
  const code = linkCode(SECRET, { team: 'T1', user: 'U1', name: 'olga' }, now)
  expect(readLinkCode(SECRET, code, now + 60_000)).toMatchObject({ team: 'T1', user: 'U1', name: 'olga' })
  expect(readLinkCode(SECRET, code, now + 16 * 60_000)).toBeNull()
  expect(readLinkCode('other', code, now)).toBeNull()
  const [payload, mac] = code.split('.')
  const forged = Buffer.from(JSON.stringify({ team: 'T1', user: 'U2', name: 'x', exp: now + 1e6 })).toString('base64url')
  expect(readLinkCode(SECRET, `${forged}.${mac}`, now)).toBeNull()
  expect(readLinkCode(SECRET, payload, now)).toBeNull()
})

it('reads commands and targets', () => {
  expect(words(`run web-* cmd.run "uptime -p" x='a b'`)).toEqual(['run', 'web-*', 'cmd.run', 'uptime -p', 'x=a b'])
  expect(parseCommand('')).toEqual({ cmd: 'help' })
  expect(parseCommand('Status')).toEqual({ cmd: 'status' })
  expect(parseCommand('run web-* service.restart nginx timeout=30')).toEqual({ cmd: 'run', tgt: 'web-*', fun: 'service.restart', arg: ['nginx'], kwarg: { timeout: '30' } })
  expect(parseCommand('highstate db-* test')).toEqual({ cmd: 'run', tgt: 'db-*', fun: 'state.apply', arg: [], kwarg: { test: 'True' } })
  expect(parseCommand('run web-*')).toMatchObject({ cmd: 'error' })
  expect(parseCommand('reboot all')).toMatchObject({ cmd: 'error', error: expect.stringContaining('Unknown command') })
  expect(targetType('web-*')).toBe('glob')
  expect(targetType('web-01,web-02')).toBe('list')
  expect(targetType('G@os:Debian and web-*')).toBe('compound')
  expect(isSlackResponseUrl('https://hooks.slack.com/commands/T1/1/abc')).toBe(true)
  expect(isSlackResponseUrl('https://evil.example/hooks.slack.com/commands/')).toBe(false)
})

describe.each(testDialects)('the /salt command (%s)', (dialect) => {
  let close: (() => Promise<unknown>) | null = null
  afterEach(async () => {
    await close?.()
    close = null
  })

  async function setup() {
    const opened = await openTestDatabase(dialect)
    close = opened.close
    const { db, schema } = opened
    const now = Date.now()
    await db.insert(schema.user).values({ id: 'u-olga', name: 'Olga', email: 'olga@x.invalid', username: 'olga', role: 'operator', createdAt: new Date(now), updatedAt: new Date(now) })
    const posted: Array<{ url: string; type: string; text: string }> = []
    const calls: Array<{ user: string; input: Record<string, unknown> }> = []
    const audited: string[] = []
    let answer: Awaited<ReturnType<SaltAs>> = { status: 200, body: { return: { jid: '2026', minions: ['web-01', 'web-02'] } } }
    const saltAs: SaltAs = async (user, input) => {
      calls.push({ user: user.username ?? user.name, input: input as Record<string, unknown> })
      return answer
    }
    let browserUser: SessionUser | null = null
    const app = new Hono<Env>()
    app.use('*', async (c, next) => {
      c.set('user', browserUser)
      c.set('via', 'session')
      await next()
    })
    app.route(
      '/api',
      slackRoutes({ db, schema, secret: SECRET, publicUrl: 'https://salt.example.com', saltAs, audit: async (r) => void audited.push(`${r.username} ${r.fun}`), post: async (url, b) => void posted.push({ url, type: b.response_type, text: b.text }), sleep: async () => undefined, waitMs: 0 }),
    )
    const slash = async (text: string, user = 'U1') => {
      const body = new URLSearchParams({ team_id: 'T1', user_id: user, user_name: 'olga.s', text, response_url: 'https://hooks.slack.com/commands/T1/1/x' }).toString()
      const ts = Math.floor(Date.now() / 1000)
      const res = await app.request('/api/slack/commands', { method: 'POST', body, headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Slack-Request-Timestamp': String(ts), 'X-Slack-Signature': sig(ts, body) } })
      // the deferred work runs on; give it a turn
      await new Promise((r) => setTimeout(r, 20))
      return { status: res.status, body: (await res.json()) as { text: string; response_type: string } }
    }
    return { db, schema, app, slash, posted, calls, audited, setAnswer: (a: typeof answer) => (answer = a), signIn: (u: SessionUser | null) => (browserUser = u) }
  }

  it('links a Slack user, then runs commands as them, and reports how the job went', async () => {
    const { db, schema, app, slash, posted, calls, audited, signIn } = await setup()

    expect((await slash('help')).body.text).toContain('/salt link')
    expect((await slash('run web-* test.ping')).body.text).toContain('isn’t linked')
    expect(calls).toEqual([])

    const link = (await slash('link')).body
    expect(link.response_type).toBe('ephemeral')
    const code = decodeURIComponent(/code=([^|>]+)/.exec(link.text)![1])

    // linking needs the browser session
    const claim = (body: unknown) => app.request('/api/slack/link', { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } })
    expect((await claim({ code })).status).toBe(401)
    signIn({ id: 'u-olga', name: 'Olga', username: 'olga', role: 'operator' })
    expect((await claim({ code: 'nope.nope' })).status).toBe(400)
    expect((await claim({ code })).status).toBe(200)
    expect(audited).toEqual(['olga slack.link'])
    expect(await (await app.request('/api/slack/links')).json()).toMatchObject({ enabled: true, links: [{ team: 'T1', slackUser: 'U1', slackName: 'olga.s' }] })

    expect((await slash('whoami')).body.text).toBe('You act as *olga* (operator) in Salt Shaker.')

    // one minion returns fine, the other fails
    await db.insert(schema.job).values({ jid: '2026', fun: 'service.restart', startedAt: new Date() })
    await db.insert(schema.jobReturn).values([
      { jid: '2026', minion: 'web-01', retcode: 0, success: true, returnedAt: new Date() },
      { jid: '2026', minion: 'web-02', retcode: 1, success: false, returnedAt: new Date() },
    ])
    const started = await slash('run web-* service.restart nginx')
    expect(started.body.text).toBe('Starting `service.restart` on `web-*`…')
    expect(calls).toEqual([{ user: 'olga', input: { client: 'local_async', tgt: 'web-*', tgt_type: 'glob', fun: 'service.restart', arg: ['nginx'], kwarg: {} } }])
    expect(posted).toEqual([
      { url: 'https://hooks.slack.com/commands/T1/1/x', type: 'in_channel', text: '*olga* ran `service.restart nginx` on `web-*` (2 minions): <https://salt.example.com/jobs/2026|job 2026>' },
      { url: 'https://hooks.slack.com/commands/T1/1/x', type: 'in_channel', text: ':x: `service.restart nginx` on `web-*`: 1 succeeded, 1 failed (web-02)' },
    ])

    // a disabled user's Slack account stops working
    await db.update(schema.user).set({ banned: true }).where(eq(schema.user.id, 'u-olga'))
    expect((await slash('status')).body.text).toContain('isn’t linked')
  })

  it('passes refusals on, and points to a change when approval is needed', async () => {
    const { slash, posted, signIn, app, setAnswer } = await setup()
    const code = decodeURIComponent(/code=([^|>]+)/.exec((await slash('link')).body.text)![1])
    signIn({ id: 'u-olga', name: 'Olga', username: 'olga', role: 'operator' })
    await app.request('/api/slack/link', { method: 'POST', body: JSON.stringify({ code }), headers: { 'Content-Type': 'application/json' } })

    setAnswer({ status: 403, body: { error: 'state.apply needs an admin’s approval: request it as a change', needsApproval: true } })
    await slash('highstate web-*')
    expect(posted.at(-1)).toMatchObject({ type: 'ephemeral', text: expect.stringContaining('<https://salt.example.com/run|open Run in Salt Shaker>') })

    setAnswer({ status: 200, body: { return: { up: ['a', 'b'], down: ['c'] } } })
    await slash('status')
    expect(posted.at(-1)).toMatchObject({ type: 'ephemeral', text: ":warning: 2 minions answer, 1 don't: c. <https://salt.example.com/minions|Minions>" })
  })

  it('refuses unsigned requests and stays off without a secret', async () => {
    const { app, db, schema } = await setup()
    const res = await app.request('/api/slack/commands', { method: 'POST', body: 'text=help', headers: { 'X-Slack-Request-Timestamp': String(Math.floor(Date.now() / 1000)), 'X-Slack-Signature': 'v0=00' } })
    expect(res.status).toBe(401)
    const off = new Hono<Env>()
    off.route('/api', slackRoutes({ db, schema, secret: null, publicUrl: '', saltAs: null as never, audit: null as never }))
    expect((await off.request('/api/slack/commands', { method: 'POST', body: '' })).status).toBe(404)
  })
})
