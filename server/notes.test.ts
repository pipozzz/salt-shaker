import { Hono } from 'hono'
import { afterEach, describe, expect, it } from 'vitest'
import { MAX_NOTE, noteRoutes } from './routes/notes'
import { openTestDatabase, testDialects } from './testdb'
import type { AuditRow, Env } from './types'

describe.each(testDialects)('minion notes (%s)', (dialect) => {
  let close: (() => Promise<unknown>) | null = null
  afterEach(async () => {
    await close?.()
    close = null
  })

  it('lets operators and admins write them, everyone read them, and audits each change', async () => {
    const opened = await openTestDatabase(dialect)
    close = opened.close
    const { db, schema } = opened
    const app = new Hono<Env>()
    app.use('*', async (c, next) => {
      const [name, role] = (c.req.header('x-user') ?? '').split(':')
      c.set('user', name ? { id: name, name, username: name, role } : null)
      await next()
    })
    const audited: AuditRow[] = []
    app.route('/api', noteRoutes({ db, schema, audit: async (r) => void audited.push(r) }))
    const put = (user: string, minion: string, body: unknown) =>
      app.request(`/api/minion-notes/${encodeURIComponent(minion)}`, { method: 'PUT', headers: { 'x-user': user, 'content-type': 'application/json' }, body: JSON.stringify(body) })
    const list = async (user: string) => {
      const res = await app.request('/api/minion-notes', { headers: { 'x-user': user } })
      return { status: res.status, body: (await res.json()) as { notes: Record<string, { note: string; updatedBy: string }> } }
    }

    expect((await list('')).status).toBe(401)
    expect((await list('nobody:none')).status).toBe(403)
    expect((await put('vera:viewer', 'db-01', { note: 'mine' })).status).toBe(403)
    expect((await put('olga:operator', 'db-01', { note: 7 })).status).toBe(400)
    expect((await put('olga:operator', 'db 01', { note: 'x' })).status).toBe(400)
    expect((await put('olga:operator', 'db-01', { note: 'x'.repeat(MAX_NOTE + 1) })).status).toBe(400)

    const made = await put('olga:operator', 'db-01', { note: '  Owner: DBA team. Don’t restart during the day.  ' })
    expect(made.status).toBe(200)
    expect(((await made.json()) as { note: { note: string } }).note.note).toBe('Owner: DBA team. Don’t restart during the day.')
    await put('ada:admin', 'web-01', { note: 'Front door' })
    // the same note again changes nothing
    await put('ada:admin', 'web-01', { note: 'Front door' })
    expect((await list('vera:viewer')).body.notes).toMatchObject({
      'db-01': { note: 'Owner: DBA team. Don’t restart during the day.', updatedBy: 'olga' },
      'web-01': { note: 'Front door', updatedBy: 'ada' },
    })

    await put('ada:admin', 'db-01', { note: 'Owner: DBA team' })
    expect((await list('vera:viewer')).body.notes['db-01']).toMatchObject({ note: 'Owner: DBA team', updatedBy: 'ada' })
    // empty removes it
    await put('olga:operator', 'web-01', { note: ' ' })
    expect(Object.keys((await list('vera:viewer')).body.notes)).toEqual(['db-01'])

    expect(audited.map((a) => `${a.username} ${a.fun} ${a.target} ${a.args}`)).toEqual([
      'olga minions.note db-01 {"note":"Owner: DBA team. Don’t restart during the day."}',
      'ada minions.note web-01 {"note":"Front door"}',
      'ada minions.note db-01 {"note":"Owner: DBA team"}',
      'olga minions.note_removed web-01 null',
    ])
  })
})
