import { afterEach, describe, expect, it } from 'vitest'
import type { Notifier } from './notify'
import type { SaltService } from './salt'
import { Scheduler } from './scheduler'
import { acceptanceMessages } from './summaries'
import { openTestDatabase, testDialects } from './testdb'
import { OsvClient, VulnService } from './vulns'

const DAY = 86400_000
const NOW = Date.UTC(2026, 10, 10, 12)

describe.each(testDialects)('risk acceptances ending (%s)', (dialect) => {
  let close: (() => Promise<unknown>) | null = null
  afterEach(async () => {
    await close?.()
    close = null
  })

  it('announces each acceptance once when it ends within 3 days, and again when it has ended', async () => {
    const opened = await openTestDatabase(dialect)
    close = opened.close
    const { db, schema } = opened
    let now = NOW
    const svc = new VulnService(db, schema, new OsvClient('http://osv.invalid', async () => new Response('{}')), { now: () => now })
    const accept = (vulnId: string, ends: number | null) => svc.accept({ vulnId, note: `why ${vulnId}`, acceptedBy: 'ops', acceptedAt: new Date(NOW - 30 * DAY), expiresAt: ends === null ? null : new Date(NOW + ends) })
    await accept('SOON', 2 * DAY)
    await accept('LATER', 10 * DAY)
    await accept('ENDED', -3600_000)
    await accept('FOREVER', null)

    const ids = (r: { soon: { vulnId: string }[]; ended: { vulnId: string }[] }) => ({ soon: r.soon.map((a) => a.vulnId), ended: r.ended.map((a) => a.vulnId) })
    expect(ids(await svc.acceptanceNotices())).toEqual({ soon: ['SOON'], ended: ['ENDED'] })
    // already told
    expect(ids(await svc.acceptanceNotices())).toEqual({ soon: [], ended: [] })

    now = NOW + 8 * DAY
    expect(ids(await svc.acceptanceNotices())).toEqual({ soon: ['LATER'], ended: ['SOON'] })

    // accepting again starts over
    await accept('SOON', 9 * DAY)
    now = NOW + 7 * DAY
    expect(ids(await svc.acceptanceNotices())).toEqual({ soon: ['SOON'], ended: [] })
  })

  it('sends them as the acceptance event from the scheduler', async () => {
    const opened = await openTestDatabase(dialect)
    close = opened.close
    const { db, schema } = opened
    const svc = new VulnService(db, schema, new OsvClient('http://osv.invalid', async () => new Response('{}')))
    await svc.accept({ vulnId: 'X-1', note: 'not exposed', acceptedBy: 'ops', acceptedAt: new Date(), expiresAt: new Date(Date.now() + DAY) })
    const sent: Array<{ event: string; title: string }> = []
    const notifier = { emit: async (event: string, m: { title: string }) => void sent.push({ event, title: m.title }) } as unknown as Notifier
    const sch = new Scheduler(db, schema, {} as SaltService, notifier, async () => undefined)
    sch.vulns = svc
    await sch.checkAcceptances(true)
    await sch.checkAcceptances(true)
    expect(sent).toEqual([{ event: 'acceptance', title: 'Risk acceptance of X-1 ends within 3 days' }])
  })
})

it('words the messages', () => {
  const a = { vulnId: 'DEBIAN-CVE-2026-1', note: 'not exposed', acceptedBy: 'ops', expiresAt: new Date(Date.UTC(2026, 10, 13)), severity: 'high', minions: 3 }
  const [soon, ended] = acceptanceMessages([a], [{ ...a, vulnId: 'DEBIAN-CVE-2026-2', severity: 'low', minions: 1 }, { ...a, vulnId: 'X', severity: null, minions: 0 }])
  expect(soon).toEqual({
    title: 'Risk acceptance of DEBIAN-CVE-2026-1 ends within 3 days',
    lines: ['DEBIAN-CVE-2026-1 (high, 3 minions): "not exposed", accepted by ops, ends 2026-11-13', 'Accept it again to extend it, or plan the upgrade.'],
    severity: 'warning',
    path: '/vulnerabilities?view=accepted',
  })
  expect(ended).toMatchObject({ title: '2 risk acceptances ended; they count again', severity: 'warning', path: '/vulnerabilities' })
  expect(ended.lines[1]).toBe('X (0 minions): "not exposed", accepted by ops, ends 2026-11-13')
})
