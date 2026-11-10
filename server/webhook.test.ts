import { createHmac } from 'node:crypto'
import { Hono } from 'hono'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Notifier, signWebhook } from './notify'
import { automationRoutes } from './routes/automation'
import type { Scheduler } from './scheduler'
import { openTestDatabase, testDialects } from './testdb'
import type { Env } from './types'

it('signs "<timestamp>.<body>" with HMAC-SHA256', () => {
  expect(signWebhook('whsec_test', 1700000000, '{"a":1}')).toBe(createHmac('sha256', 'whsec_test').update('1700000000.{"a":1}').digest('hex'))
})

describe.each(testDialects)('signed webhooks (%s)', (dialect) => {
  let close: (() => Promise<unknown>) | null = null
  afterEach(async () => {
    vi.restoreAllMocks()
    await close?.()
    close = null
  })

  it('gives a JSON webhook a secret once, signs with it, and replaces it on request', async () => {
    const opened = await openTestDatabase(dialect)
    close = opened.close
    const notifier = new Notifier(opened.db, opened.schema, 'https://shaker.example')
    const app = new Hono<Env>()
    app.use('*', async (c, next) => {
      c.set('user', { id: 'ada', name: 'ada', username: 'ada', role: 'admin' })
      await next()
    })
    const audited: string[] = []
    app.route('/api', automationRoutes({ ...opened, scheduler: {} as Scheduler, notifier, audit: async (r) => void audited.push(r.fun) }))
    const call = async (method: string, path: string, body?: unknown) => {
      const res = await app.request(`/api${path}`, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
      return { status: res.status, body: (await res.json()) as Record<string, unknown> }
    }

    const hook = await call('POST', '/notifications', { name: 'hook', kind: 'webhook', url: 'https://alerts.example/salt', events: ['drift'] })
    const secret = hook.body.secret as string
    expect(secret).toMatch(/^whsec_[\w-]{32}$/)
    const slack = await call('POST', '/notifications', { name: 'chat', kind: 'slack', url: 'https://hooks.slack.com/services/x', events: ['drift'] })
    expect(slack.body.secret).toBeUndefined()

    // listed as signed, never with the secret
    const list = (await call('GET', '/notifications')).body.channels as Array<Record<string, unknown>>
    expect(list.map((c) => [c.name, c.signed, 'secret' in c])).toEqual([
      ['chat', false, false],
      ['hook', true, false],
    ])

    // what the receiver gets, and how it checks it
    const sent: Array<{ url: string; headers: Record<string, string>; body: string }> = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      sent.push({ url: String(url), headers: init!.headers as Record<string, string>, body: String(init!.body) })
      return new Response('ok')
    })
    await notifier.emit('drift', { title: 'Drift', lines: [], severity: 'warning' })
    const toHook = sent.find((s) => s.url.includes('alerts.example'))!
    const ts = Number(toHook.headers['X-Salt-Shaker-Timestamp'])
    expect(Math.abs(ts - Date.now() / 1000)).toBeLessThan(5)
    expect(toHook.headers['X-Salt-Shaker-Signature']).toBe(`sha256=${createHmac('sha256', secret).update(`${ts}.${toHook.body}`).digest('hex')}`)
    expect(sent.find((s) => s.url.includes('slack'))!.headers['X-Salt-Shaker-Signature']).toBeUndefined()

    // a new secret replaces the old one; chat channels have none to replace
    const rotated = await call('POST', `/notifications/${hook.body.id}/secret`)
    expect(rotated.body.secret).not.toBe(secret)
    expect((await call('POST', `/notifications/${slack.body.id}/secret`)).status).toBe(400)
    sent.length = 0
    await notifier.emit('drift', { title: 'Drift', lines: [], severity: 'warning' })
    const again = sent.find((s) => s.url.includes('alerts.example'))!
    expect(again.headers['X-Salt-Shaker-Signature']).toBe(`sha256=${signWebhook(rotated.body.secret as string, Number(again.headers['X-Salt-Shaker-Timestamp']), again.body)}`)
    expect(audited).toContain('notification.rotate_secret')
  })
})
