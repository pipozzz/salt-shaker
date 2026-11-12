import { Hono } from 'hono'
import { afterEach, describe, expect, it } from 'vitest'
import { mailFor, readRecipients, type Mail } from './mail'
import { Notifier } from './notify'
import { automationRoutes } from './routes/automation'
import type { Scheduler } from './scheduler'
import { openTestDatabase, testDialects } from './testdb'
import type { Env } from './types'

it('reads a list of recipients', () => {
  expect(readRecipients(' Ops@Example.com; cto@example.com\nops@example.com ')).toEqual({ to: ['ops@example.com', 'cto@example.com'] })
  expect(readRecipients(' ')).toEqual({ error: 'Add at least one email address' })
  expect(readRecipients('ops@example.com, nope')).toEqual({ error: '"nope" is not an email address' })
  expect(readRecipients(Array.from({ length: 21 }, (_, i) => `u${i}@example.com`).join(','))).toMatchObject({ error: expect.stringContaining('mailing list') })
})

it('makes an email from a message, escaped, with a link back', () => {
  const mail = mailFor({ title: 'Drift on <web-01>', lines: ['1 drifted', 'a & b'], severity: 'warning', path: '/jobs/1' }, ['ops@example.com'], 'https://salt.example.com')
  expect(mail.subject).toBe('Drift on <web-01>')
  expect(mail.text).toBe('Drift on <web-01>\n\n1 drifted\na & b\n\nOpen in Salt Shaker: https://salt.example.com/jobs/1\n')
  expect(mail.html).toContain('Drift on &lt;web-01&gt;')
  expect(mail.html).toContain('a &amp; b')
  expect(mail.html).toContain('href="https://salt.example.com/jobs/1"')
})

describe.each(testDialects)('email channels (%s)', (dialect) => {
  let close: (() => Promise<unknown>) | null = null
  afterEach(async () => {
    await close?.()
    close = null
  })

  it('lists who receives them, sends through SMTP, and says when email is off', async () => {
    const opened = await openTestDatabase(dialect)
    close = opened.close
    const notifier = new Notifier(opened.db, opened.schema, 'https://salt.example.com')
    const app = new Hono<Env>()
    app.use('*', async (c, next) => {
      c.set('user', { id: 'ada', name: 'ada', username: 'ada', role: 'admin' })
      await next()
    })
    app.route('/api', automationRoutes({ ...opened, scheduler: {} as Scheduler, notifier, audit: async () => undefined }))
    const call = async (method: string, path: string, body?: unknown) => {
      const res = await app.request(`/api${path}`, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
      return { status: res.status, body: (await res.json()) as Record<string, unknown> }
    }

    expect((await call('GET', '/automation/meta')).body.email).toBe(false)
    expect(await call('POST', '/notifications', { name: 'mgmt', kind: 'email', url: 'nope', events: ['report'] })).toEqual({ status: 400, body: { error: '"nope" is not an email address' } })
    const created = await call('POST', '/notifications', { name: 'mgmt', kind: 'email', url: 'CTO@example.com, ops@example.com', events: ['report'] })
    expect(created.body.secret).toBeUndefined()
    const id = created.body.id as number
    // recipients aren't secret, so they're listed as they are
    const list = (await call('GET', '/notifications')).body.channels as Array<Record<string, unknown>>
    expect(list[0]).toMatchObject({ kind: 'email', url: 'cto@example.com, ops@example.com' })

    // without SMTP_URL the test says why it can't send
    expect(await call('POST', `/notifications/${id}/test`)).toEqual({ status: 502, body: { error: 'Email is off: set SMTP_URL on the server' } })

    const sent: Mail[] = []
    notifier.mail = async (m) => void sent.push(m)
    expect((await call('GET', '/automation/meta')).body.email).toBe(true)
    await notifier.emit('report', { title: 'Week 46', lines: ['40 minions'], severity: 'info', path: '/' })
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ to: ['cto@example.com', 'ops@example.com'], subject: 'Week 46' })

    // an SMTP failure shows on the channel
    notifier.mail = async () => {
      throw new Error('535 Authentication failed')
    }
    expect(await call('POST', `/notifications/${id}/test`)).toEqual({ status: 502, body: { error: '535 Authentication failed' } })
    const after = (await call('GET', '/notifications')).body.channels as Array<Record<string, unknown>>
    expect(after[0].lastError).toBe('535 Authentication failed')
  })
})
