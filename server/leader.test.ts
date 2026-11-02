import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Leader } from './leader'
import { openTestDatabase, testDialects } from './testdb'

const noop = { onAcquire: () => undefined, onLose: () => undefined }

describe.each(testDialects)('Leader (%s)', (dialect) => {
  let opened: Awaited<ReturnType<typeof openTestDatabase>>
  beforeAll(async () => {
    opened = await openTestDatabase(dialect)
  })
  afterAll(() => opened.close())

  it('lets only one instance hold the lease', async () => {
    const a = new Leader(opened.db, opened.schema, 'events', noop, 30_000, 'a')
    const b = new Leader(opened.db, opened.schema, 'events', noop, 30_000, 'b')
    const now = new Date('2026-11-01T12:00:00Z')
    expect(await a.tryAcquire(now)).toBe(true)
    expect(await b.tryAcquire(now)).toBe(false)
    // the holder renews
    expect(await a.tryAcquire(new Date(now.getTime() + 10_000))).toBe(true)
    expect(await b.tryAcquire(new Date(now.getTime() + 20_000))).toBe(false)
  })

  it('hands over once the holder stops renewing', async () => {
    const a = new Leader(opened.db, opened.schema, 'handover', noop, 30_000, 'a')
    const b = new Leader(opened.db, opened.schema, 'handover', noop, 30_000, 'b')
    const now = new Date('2026-11-01T12:00:00Z')
    expect(await a.tryAcquire(now)).toBe(true)
    const later = new Date(now.getTime() + 31_000)
    expect(await b.tryAcquire(later)).toBe(true)
    expect(await a.tryAcquire(later)).toBe(false)
  })

  it('keeps separate leases apart', async () => {
    const a = new Leader(opened.db, opened.schema, 'one', noop, 30_000, 'a')
    const b = new Leader(opened.db, opened.schema, 'two', noop, 30_000, 'b')
    expect(await a.tryAcquire()).toBe(true)
    expect(await b.tryAcquire()).toBe(true)
  })
})
