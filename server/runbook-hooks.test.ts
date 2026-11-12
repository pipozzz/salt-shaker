import { createHmac } from 'node:crypto'
import { Hono } from 'hono'
import { afterEach, describe, expect, it } from 'vitest'
import type { RunbookInput } from '../src/lib/runbook'
import { hookRoutes, hookUser, readCallValues, verifyCall } from './runbook-hooks'
import { runbookRoutes, RunbookRunner } from './runbooks'
import { openTestDatabase, testDialects } from './testdb'
import type { Env, SessionUser } from './types'

const ada: SessionUser = { id: 'a', name: 'Ada', username: 'ada', role: 'admin' }
const olga: SessionUser = { id: 'o', name: 'Olga', username: 'olga', role: 'operator' }

const restart: RunbookInput = {
  name: 'Restart a service',
  description: '',
  params: [
    { name: 'host', label: 'Minion', default: '', required: true },
    { name: 'service', label: 'Service', default: 'nginx', required: true },
  ],
  steps: [{ name: 'Restart', fun: 'service.restart', target: '{{host}}', targetType: 'glob', args: '{{service}}', continueOnFailure: false }],
}

const sign = (secret: string, ts: number, body: string) => `sha256=${createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex')}`

describe('verifyCall', () => {
  const now = Date.parse('2026-11-12T10:00:00Z')
  const ts = now / 1000
  it('takes a fresh signature over the body, or the secret as a bearer token', () => {
    expect(verifyCall('s3cret', { timestamp: String(ts), signature: sign('s3cret', ts, '{}') }, '{}', now)).toBe(true)
    expect(verifyCall('s3cret', { timestamp: String(ts), signature: sign('s3cret', ts, '{}') }, '{"host":"*"}', now)).toBe(false)
    expect(verifyCall('s3cret', { timestamp: String(ts - 600), signature: sign('s3cret', ts - 600, '{}') }, '{}', now)).toBe(false)
    expect(verifyCall('s3cret', { signature: sign('s3cret', ts, '{}') }, '{}', now)).toBe(false)
    expect(verifyCall('s3cret', { authorization: 'Bearer s3cret' }, '', now)).toBe(true)
    expect(verifyCall('s3cret', { authorization: 'Bearer s3cre' }, '', now)).toBe(false)
    // a bad signature isn't rescued by a good bearer token
    expect(verifyCall('s3cret', { authorization: 'Bearer s3cret', timestamp: String(ts), signature: 'sha256=00' }, '', now)).toBe(false)
  })
})

describe('readCallValues', () => {
  it('takes only the values the webhook lets a call set, from the top level or under params', () => {
    expect(readCallValues('{"host":"web-01","service":"x","labels":{"a":1}}', ['host'])).toEqual({ values: { host: 'web-01' } })
    expect(readCallValues('{"params":{"host":"web-02"},"host":"no"}', ['host'])).toEqual({ values: { host: 'web-02' } })
    expect(readCallValues('{"host":12}', ['host'])).toEqual({ values: { host: '12' } })
    expect(readCallValues('', ['host'])).toEqual({ values: {} })
    expect(readCallValues('{"host":["a"]}', ['host'])).toEqual({ error: '"host" must be text' })
    expect(readCallValues('nope', ['host'])).toEqual({ error: 'The body is not JSON' })
    expect(readCallValues('[1]', ['host'])).toEqual({ error: 'The body is not a JSON object' })
  })
})

describe.each(testDialects)('runbook webhooks (%s)', (dialect) => {
  let close: (() => Promise<unknown>) | null = null
  afterEach(async () => {
    await close?.()
    close = null
  })

  async function setup(approval: 'off' | 'risky' = 'off') {
    const opened = await openTestDatabase(dialect)
    close = opened.close
    const { db, schema } = opened
    const calls: Array<{ user: string; role: string | null | undefined; low: Record<string, unknown> }> = []
    let jid = 0
    const saltAs = async (user: SessionUser, input: unknown) => {
      const low = input as Record<string, unknown>
      calls.push({ user: user.username!, role: user.role, low })
      return { status: 200, body: { return: { jid: `j${++jid}`, minions: [String(low.tgt)] } } }
    }
    const emitted: string[] = []
    const notifier = { emit: async (event: string, msg: { title: string }) => void emitted.push(`${event}: ${msg.title}`) }
    const now = Date.parse('2026-11-12T10:00:00Z')
    const runner = new RunbookRunner({ db, schema, saltAs, loadUser: async (id) => (id.startsWith('hook:') ? hookUser(db, schema, id) : id === 'a' ? ada : null), notifier, now: () => now })
    const audited: string[] = []
    const deps = { db, schema, runner, notifier, audit: async (r: { username: string; fun: string; target?: string | null }) => void audited.push(`${r.username} ${r.fun} ${r.target}`), approval, now: () => now }
    let user: SessionUser | null = null
    const app = new Hono<Env>()
    app.use('*', async (c, next) => {
      c.set('user', user)
      await next()
    })
    app.route('/api', runbookRoutes(deps))
    app.route('/api', hookRoutes(deps))
    const call = async (as: SessionUser | null, method: string, path: string, body?: unknown) => {
      user = as
      const res = await app.request(`/api${path}`, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
      return { status: res.status, body: (await res.json()) as Record<string, unknown> }
    }
    const hit = async (id: number, body: string, headers: Record<string, string>) => {
      user = null
      const res = await app.request(`/api/hooks/runbooks/${id}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body })
      return { status: res.status, body: (await res.json()) as Record<string, unknown> }
    }
    const rbId = ((await call(ada, 'POST', '/runbooks', restart)).body.runbook as { id: number }).id
    return { db, schema, call, hit, calls, emitted, audited, runner, rbId, now }
  }

  it('admins make a webhook that covers every required value, and see its secret once', async () => {
    const { call, rbId, audited } = await setup()
    expect((await call(olga, 'POST', '/runbook-hooks', { name: 'Alerts', runbookId: rbId })).status).toBe(403)
    expect(await call(ada, 'POST', '/runbook-hooks', { name: 'Alerts', runbookId: rbId })).toEqual({ status: 400, body: { error: 'Minion is required: set it here or let the call set it' } })
    const made = await call(ada, 'POST', '/runbook-hooks', { name: 'Alerts', runbookId: rbId, params: { service: 'nginx', nope: 'x' }, fromRequest: ['host', 'nope'] })
    expect(made.status).toBe(201)
    expect(made.body.secret).toMatch(/^whk_/)
    expect(made.body.hook).toMatchObject({ name: 'Alerts', params: { service: 'nginx' }, fromRequest: ['host'], enabled: true })
    expect(made.body.hook).not.toHaveProperty('secret')
    const listed = (await call(ada, 'GET', '/runbook-hooks')).body.hooks as Array<Record<string, unknown>>
    expect(listed[0]).not.toHaveProperty('secret')
    expect((await call(ada, 'POST', '/runbook-hooks', { name: 'Alerts', runbookId: rbId, fromRequest: ['host'] })).body).toEqual({ error: 'A webhook with this name already exists' })
    expect(audited.at(-1)).toBe('ada runbook_hook.create Alerts')
  })

  it('a call with the secret starts the run as the webhook, with the values it may set, one run at a time', async () => {
    const { call, hit, calls, rbId, runner, db, schema, now } = await setup()
    const made = await call(ada, 'POST', '/runbook-hooks', { name: 'Alerts', runbookId: rbId, params: { service: 'nginx' }, fromRequest: ['host'] })
    const id = (made.body.hook as { id: number }).id
    const secret = made.body.secret as string

    expect(await hit(id, '{"host":"web-01"}', { authorization: 'Bearer wrong' })).toEqual({ status: 401, body: { error: 'Unknown webhook, or a wrong secret or signature' } })
    expect((await hit(999, '{}', { authorization: `Bearer ${secret}` })).status).toBe(401)

    // a tool's own payload: only host is taken; service stays what the webhook set
    const body = JSON.stringify({ host: 'web-01', service: 'sshd', status: 'firing' })
    const ts = now / 1000
    const first = await hit(id, body, { 'x-salt-shaker-timestamp': String(ts), 'x-salt-shaker-signature': sign(secret, ts, body) })
    expect(first).toEqual({ status: 202, body: { run: expect.any(Number), status: 'running', path: `/runbooks/runs/${first.body.run}` } })
    expect(calls).toEqual([{ user: 'hook:Alerts', role: 'operator', low: expect.objectContaining({ tgt: 'web-01', fun: 'service.restart', arg: ['nginx'] }) }])
    const run = (await call(ada, 'GET', `/runbook-runs/${first.body.run}`)).body.run as Record<string, unknown>
    expect(run).toMatchObject({ startedBy: 'hook:Alerts', params: { host: 'web-01', service: 'nginx' } })

    expect(await hit(id, '{"host":"web-02"}', { authorization: `Bearer ${secret}` })).toEqual({ status: 409, body: { error: `Its last run, #${first.body.run}, hasn't finished`, run: first.body.run } })
    await db.insert(schema.jobReturn).values({ jid: 'j1', minion: 'web-01', success: true, retcode: 0, returnedAt: new Date() })
    await runner.tick()
    expect((await call(ada, 'GET', `/runbook-runs/${first.body.run}`)).body.run).toMatchObject({ status: 'done' })

    // a required value the call didn't set
    expect(await hit(id, '{}', { authorization: `Bearer ${secret}` })).toEqual({ status: 400, body: { error: 'Minion is required' } })
    const [listed] = (await call(ada, 'GET', '/runbook-hooks')).body.hooks as Array<Record<string, unknown>>
    expect(listed).toMatchObject({ lastRunId: first.body.run, lastError: 'Minion is required' })

    // turned off, and a new secret: the old one stops working
    await call(ada, 'PATCH', `/runbook-hooks/${id}`, { enabled: false })
    expect(await hit(id, '{"host":"web-01"}', { authorization: `Bearer ${secret}` })).toEqual({ status: 403, body: { error: 'This webhook is turned off' } })
    await call(ada, 'PATCH', `/runbook-hooks/${id}`, { enabled: true })
    const rotated = (await call(ada, 'POST', `/runbook-hooks/${id}/secret`)).body.secret as string
    expect((await hit(id, '{"host":"web-01"}', { authorization: `Bearer ${secret}` })).status).toBe(401)
    expect((await hit(id, '{"host":"web-01"}', { authorization: `Bearer ${rotated}` })).status).toBe(202)

    // its runbook stays while the webhook runs it
    expect(await call(ada, 'DELETE', `/runbooks/${rbId}`)).toEqual({ status: 400, body: { error: 'The webhook "Alerts" runs it; delete that webhook first' } })
  })

  it("with approval on, a webhook's risky run waits for an admin; admins can send a test call", async () => {
    const { call, calls, emitted, rbId, audited } = await setup('risky')
    const made = await call(ada, 'POST', '/runbook-hooks', { name: 'Alerts', runbookId: rbId, fromRequest: ['host'] })
    const id = (made.body.hook as { id: number }).id
    const res = await call(ada, 'POST', `/runbook-hooks/${id}/test`, { host: 'web-01' })
    expect(res).toMatchObject({ status: 202, body: { status: 'pending' } })
    expect(calls).toHaveLength(0)
    expect(emitted).toEqual(['approval: Runbook "Restart a service" waits for approval'])
    expect(audited.slice(-2)).toEqual(['ada runbook_hook.test Alerts', `hook:Alerts runbook.run #${res.body.run} Restart a service`])
    // any admin may approve it: the webhook started it
    expect((await call(ada, 'POST', `/runbook-runs/${res.body.run}/approve`)).status).toBe(200)
    expect(calls[0]).toMatchObject({ user: 'hook:Alerts', role: 'operator' })
  })
})
