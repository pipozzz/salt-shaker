import { desc } from 'drizzle-orm'
import { afterEach, describe, expect, it } from 'vitest'
import { auditCsv, auditFilter, auditWhere, type AuditFilter } from './audit'
import { openTestDatabase, testDialects } from './testdb'

describe('auditFilter', () => {
  it('drops values that do not parse', () => {
    const q = { q: '  web ', outcome: 'maybe', from: '2026-13-40', to: 'yesterday', before: 'x' } as Record<string, string>
    expect(auditFilter((k) => q[k])).toEqual({ q: 'web', outcome: undefined, from: undefined, to: undefined, before: null })
    const ok = { outcome: 'denied', from: '2026-11-01', to: '2026-11-02', before: '7' } as Record<string, string>
    expect(auditFilter((k) => ok[k])).toEqual({ q: undefined, outcome: 'denied', from: '2026-11-01', to: '2026-11-02', before: 7 })
  })
})

describe.each(testDialects)('audit queries (%s)', (dialect) => {
  let close: (() => Promise<unknown>) | null = null
  afterEach(async () => {
    await close?.()
    close = null
  })

  async function setup() {
    const opened = await openTestDatabase(dialect)
    close = opened.close
    const { db, schema } = opened
    await db.insert(schema.auditLog).values([
      { at: new Date('2026-10-31T23:59:59Z'), username: 'otto', client: 'local', fun: 'cmd.run', target: 'web-01', outcome: 'ok', args: '{"arg":["=1+1"]}' },
      { at: new Date('2026-11-01T00:00:00Z'), username: 'Anna', client: 'local', fun: 'state.apply', target: 'db-01', outcome: 'denied', error: 'Not allowed' },
      { at: new Date('2026-11-02T23:59:59Z'), username: 'otto', client: 'wheel', fun: 'key.accept', outcome: 'error', error: 'boom, "bad"' },
      { at: new Date('2026-11-03T00:00:00Z'), username: 'otto', client: 'local', fun: 'test.ping', target: 'web-02', outcome: 'ok' },
    ])
    const find = async (f: AuditFilter) => {
      const t = schema.auditLog
      const rows = await db.select().from(t).where(auditWhere(schema, f)).orderBy(desc(t.id))
      return rows.map((r) => r.fun)
    }
    return { db, schema, find }
  }

  it('filters by text, outcome and whole UTC days', async () => {
    const { find } = await setup()
    expect(await find({ q: 'anna' })).toEqual(['state.apply'])
    expect(await find({ q: 'WEB' })).toEqual(['test.ping', 'cmd.run'])
    expect(await find({ outcome: 'ok' })).toEqual(['test.ping', 'cmd.run'])
    expect(await find({ from: '2026-11-01', to: '2026-11-02' })).toEqual(['key.accept', 'state.apply'])
    expect(await find({ from: '2026-11-01', outcome: 'ok' })).toEqual(['test.ping'])
    expect(await find({ to: '2026-10-31' })).toEqual(['cmd.run'])
  })

  it('writes CSV with ISO times and defused cells', async () => {
    const { db, schema } = await setup()
    const rows = await db.select().from(schema.auditLog).orderBy(schema.auditLog.id)
    const lines = auditCsv(rows).split('\r\n')
    expect(lines[0]).toBe('id,at,username,role,client,function,target,target_type,arguments,jid,outcome,error,ip')
    expect(lines[1]).toBe('1,2026-10-31T23:59:59.000Z,otto,,local,cmd.run,web-01,,"{""arg"":[""=1+1""]}",,ok,,')
    expect(lines[3]).toBe('3,2026-11-02T23:59:59.000Z,otto,,wheel,key.accept,,,,,error,"boom, ""bad""",')
    expect(lines).toHaveLength(6)
  })
})
