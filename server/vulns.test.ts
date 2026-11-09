import { Hono } from 'hono'
import { afterEach, describe, expect, it } from 'vitest'
import { INVENTORY_KWARG, INVENTORY_SCRIPT } from '../src/lib/inventory'
import { vulnRoutes } from './routes/vulns'
import { vulnMessage } from './summaries'
import { openTestDatabase, testDialects } from './testdb'
import type { Env } from './types'
import { cvss3Score, ecosystemFor, OsvClient, parseInventory, severityCounts, VulnService, vulnInfo, vulnScanSummary } from './vulns'

const inventory = (os: string, ...pkgs: string[]) => [`os\t${os}`, ...pkgs.map((p) => `pkg\t${p}`), ''].join('\n')

describe('parseInventory', () => {
  it('reads the OS and merges binary packages built from the same source', () => {
    const inv = parseInventory(inventory('debian\t12\t12 (bookworm)', 'openssl\t3.0.11-1~deb12u2\tlibssl3', 'openssl\t3.0.11-1~deb12u2\topenssl', 'bash\t5.2.15-2+b2\tbash'))
    expect(inv).toEqual({
      os: { id: 'debian', versionId: '12', version: '12 (bookworm)' },
      ecosystem: 'Debian:12',
      packages: [
        { name: 'openssl', version: '3.0.11-1~deb12u2', binaries: ['libssl3', 'openssl'] },
        { name: 'bash', version: '5.2.15-2+b2', binaries: ['bash'] },
      ],
    })
  })

  it('rejects anything that is not the script output', () => {
    expect(parseInventory("'cmd.run' is not available.")).toBeNull()
    expect(parseInventory({ error: true })).toBeNull()
  })
})

describe('ecosystemFor', () => {
  it('names the OSV ecosystem of supported releases', () => {
    expect(ecosystemFor('debian', '12')).toBe('Debian:12')
    expect(ecosystemFor('ubuntu', '24.04', '24.04.1 LTS (Noble Numbat)')).toBe('Ubuntu:24.04:LTS')
    expect(ecosystemFor('ubuntu', '24.10', '24.10 (Oracular Oriole)')).toBe('Ubuntu:24.10')
    expect(ecosystemFor('almalinux', '9.4')).toBe('AlmaLinux:9')
    expect(ecosystemFor('rocky', '9.3')).toBe('Rocky Linux:9')
    expect(ecosystemFor('alpine', '3.20.10')).toBe('Alpine:v3.20')
  })

  it('has nothing for other systems or rolling releases', () => {
    expect(ecosystemFor('debian', '')).toBeNull()
    expect(ecosystemFor('rhel', '9.4')).toBeNull()
    expect(ecosystemFor('arch', '')).toBeNull()
  })
})

describe('cvss3Score', () => {
  it('computes base scores', () => {
    expect(cvss3Score('CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H')).toBe(9.8)
    expect(cvss3Score('CVSS:3.1/AV:N/AC:H/PR:N/UI:N/S:U/C:N/I:N/A:H')).toBe(5.9)
    expect(cvss3Score('CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:C/C:H/I:H/A:H')).toBe(10)
    expect(cvss3Score('CVSS:3.1/AV:L/AC:L/PR:L/UI:N/S:U/C:H/I:H/A:H')).toBe(7.8)
    expect(cvss3Score('CVSS:3.0/AV:N/AC:L/PR:N/UI:R/S:C/C:L/I:L/A:N')).toBe(6.1)
    expect(cvss3Score('CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:N')).toBe(0)
  })

  it('ignores other versions and broken vectors', () => {
    expect(cvss3Score('CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N')).toBeNull()
    expect(cvss3Score('CVSS:3.1/AV:X')).toBeNull()
  })
})

describe('vulnInfo', () => {
  it("prefers the distribution's rating, then CVSS, and keeps fixed versions", () => {
    const ubuntu = vulnInfo({
      id: 'UBUNTU-CVE-2024-2511',
      details: 'Issue summary: Some non-default TLS server configurations can cause unbounded memory growth',
      upstream: ['CVE-2024-2511'],
      severity: [
        { type: 'CVSS_V3', score: 'CVSS:3.1/AV:N/AC:H/PR:N/UI:N/S:U/C:N/I:N/A:H' },
        { type: 'Ubuntu', score: 'low' },
      ],
      affected: [{ package: { name: 'openssl', ecosystem: 'Ubuntu:24.04:LTS' }, ranges: [{ type: 'ECOSYSTEM', events: [{ introduced: '0' }, { fixed: '3.0.13-0ubuntu3.2' }] }] }],
    })
    expect(ubuntu).toEqual({
      id: 'UBUNTU-CVE-2024-2511',
      summary: 'Some non-default TLS server configurations can cause unbounded memory growth',
      cves: ['CVE-2024-2511'],
      severity: 'low',
      score: 5.9,
      fixed: { 'Ubuntu:24.04:LTS|openssl': '3.0.13-0ubuntu3.2' },
    })
    expect(vulnInfo({ id: 'ALSA-2024:6783', summary: 'Important: openssl security update', upstream: ['CVE-2024-6119'] }).severity).toBe('high')
    expect(vulnInfo({ id: 'DEBIAN-CVE-1', severity: [{ type: 'CVSS_V3', score: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H' }] }).severity).toBe('critical')
    expect(vulnInfo({ id: 'DEBIAN-CVE-2', affected: [{ ecosystem_specific: { urgency: 'unimportant' } }] }).severity).toBe('low')
    // Debian's urgency wins over the CVSS score; "not yet assigned" doesn't count
    const disputed = { type: 'CVSS_V3', score: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H' }
    expect(vulnInfo({ id: 'DEBIAN-CVE-3', severity: [disputed], affected: [{ ecosystem_specific: { urgency: 'unimportant' } }] })).toMatchObject({ severity: 'low', score: 9.8 })
    expect(vulnInfo({ id: 'DEBIAN-CVE-4', severity: [disputed], affected: [{ ecosystem_specific: { urgency: 'not yet assigned' } }] }).severity).toBe('critical')
    expect(vulnInfo({ id: 'X-1' }).severity).toBe('unknown')
  })
})

const NOW = Date.UTC(2026, 10, 1, 11)

/** A fake OSV.dev: which vulnerabilities affect which `name@version`, and the records. */
function fakeOsv(affects: Record<string, string[]>, records: Record<string, object>) {
  const calls = { batch: 0, packages: 0, vulns: [] as string[] }
  const fetchFn = async (url: string, init?: RequestInit) => {
    if (url.endsWith('/v1/querybatch')) {
      calls.batch++
      const { queries } = JSON.parse(String(init!.body)) as { queries: { package: { name: string }; version: string }[] }
      calls.packages += queries.length
      const results = queries.map((q) => ({ vulns: (affects[`${q.package.name}@${q.version}`] ?? []).map((id) => ({ id, modified: '2026-01-01T00:00:00Z' })) }))
      return Response.json({ results: results.map((r) => (r.vulns.length ? r : {})) })
    }
    const id = decodeURIComponent(url.split('/v1/vulns/')[1])
    calls.vulns.push(id)
    return records[id] ? Response.json(records[id]) : new Response('not found', { status: 404 })
  }
  return { client: new OsvClient('https://osv.test', fetchFn), calls, fetchFn }
}

describe.each(testDialects)('VulnService (%s)', (dialect) => {
  let close: (() => Promise<unknown>) | null = null
  afterEach(async () => {
    await close?.()
    close = null
  })

  async function setup() {
    const opened = await openTestDatabase(dialect)
    close = opened.close
    const { db, schema } = opened
    const at = (m: number) => new Date(Date.UTC(2026, 10, 1, 10, m))
    const scan = async (jid: string, minute: number, returns: Record<string, { ret: unknown; retcode?: number }>) => {
      const args = JSON.stringify([INVENTORY_SCRIPT, { __kwarg__: true, ...INVENTORY_KWARG }])
      await db.insert(schema.job).values({ jid, fun: 'cmd.run', args, target: '*', targetType: 'glob', minions: JSON.stringify(Object.keys(returns)), startedAt: at(minute) })
      await db.insert(schema.jobReturn).values(Object.entries(returns).map(([minion, r]) => ({ jid, minion, ret: JSON.stringify(r.ret), retcode: r.retcode ?? 0, success: !r.retcode, returnedAt: at(minute) })))
    }
    return { ...opened, scan }
  }

  const records = {
    'DEBIAN-CVE-2024-1': { id: 'DEBIAN-CVE-2024-1', upstream: ['CVE-2024-1'], details: 'Bad thing', severity: [{ type: 'CVSS_V3', score: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H' }], affected: [{ package: { name: 'openssl', ecosystem: 'Debian:12' }, ranges: [{ type: 'ECOSYSTEM', events: [{ introduced: '0' }, { fixed: '3.0.15-1~deb12u1' }] }] }] },
    'DEBIAN-CVE-2024-2': { id: 'DEBIAN-CVE-2024-2', upstream: ['CVE-2024-2'], details: 'Unfixed thing', affected: [{ package: { name: 'bash', ecosystem: 'Debian:12' }, ranges: [{ type: 'ECOSYSTEM', events: [{ introduced: '0' }] }], ecosystem_specific: { urgency: 'unimportant' } }] },
  }
  const affects = { 'openssl@3.0.11-1~deb12u2': ['DEBIAN-CVE-2024-1', 'DSA-5000-1'], 'bash@5.2.15-2': ['DEBIAN-CVE-2024-2'] }

  it('matches the latest inventories against OSV.dev and caches the answers', async () => {
    const { db, schema, scan } = await setup()
    const osv = fakeOsv(affects, records)
    const debian = inventory('debian\t12\t12 (bookworm)', 'openssl\t3.0.11-1~deb12u2\tlibssl3', 'bash\t5.2.15-2\tbash', 'zlib\t1.2.13\tzlib1g')
    await scan('1', 0, { web: { ret: inventory('debian\t12\t12', 'openssl\t3.0.9-1\tlibssl3') }, win: { ret: "'/bin/sh' is not recognized", retcode: 1 } })
    await scan('2', 5, { web: { ret: debian }, db: { ret: debian }, arch: { ret: inventory('arch\t\t', 'glibc\t2.40\tglibc') } })
    let now = NOW
    const svc = new VulnService(db, schema, osv.client, { now: () => now })

    const { report, updating } = await svc.get()
    expect(updating).toBe(false)
    expect(report!.error).toBeNull()
    const by = Object.fromEntries(report!.minions.map((m) => [m.minion, m]))
    expect(Object.keys(by).sort()).toEqual(['arch', 'db', 'web', 'win'])
    // the newer inventory wins; DSA advisories repeat the per-CVE records and are left out
    expect(by.web.jid).toBe('2')
    expect(by.web.findings.map((f) => [f.vuln.id, f.package, f.binaries, f.fixed])).toEqual([
      ['DEBIAN-CVE-2024-1', 'openssl', ['libssl3'], '3.0.15-1~deb12u1'],
      ['DEBIAN-CVE-2024-2', 'bash', ['bash'], null],
    ])
    expect(severityCounts(by.web.findings)).toEqual({ critical: 1, high: 0, medium: 0, low: 1, unknown: 0, fixable: 1 })
    expect(by.win.error).toBe("'/bin/sh' is not recognized")
    expect(by.arch.error).toBe('OSV.dev has no vulnerability data for arch')
    // three package versions in the fleet, asked once; each record fetched once
    expect(osv.calls).toEqual({ batch: 1, packages: 3, vulns: ['DEBIAN-CVE-2024-1', 'DEBIAN-CVE-2024-2'] })

    // a new scan with the same packages: the cache answers
    await scan('3', 10, { web: { ret: debian } })
    const again = new VulnService(db, schema, osv.client, { now: () => now })
    expect((await again.get()).report!.minions.find((m) => m.minion === 'web')!.jid).toBe('3')
    expect(osv.calls.batch).toBe(1)

    // within the hour the report is reused; after the package TTL OSV is asked again, but
    // records that didn't change aren't fetched again
    now += 30 * 60_000
    await again.get()
    expect(osv.calls.batch).toBe(1)
    now += 13 * 3600_000
    await again.get()
    expect(osv.calls.batch).toBe(2)
    expect(osv.calls.vulns).toHaveLength(2)
  })

  it('leaves out old inventories and minions whose key is gone', async () => {
    const { db, schema, scan } = await setup()
    const debian = inventory('debian\t12\t12', 'bash\t5.2.15-2\tbash')
    await scan('1', 0, { web: { ret: debian }, old: { ret: debian }, gone: { ret: debian } })
    await scan('2', 5, { web: { ret: "'/bin/sh' failed", retcode: 1 } })
    const osv = fakeOsv(affects, records)
    // a failed newer scan doesn't hide an older good inventory
    const recent = new VulnService(db, schema, osv.client, { now: () => NOW })
    const by = Object.fromEntries((await recent.get()).report!.minions.map((m) => [m.minion, m]))
    expect(by.web.jid).toBe('1')
    expect(by.web.error).toBeNull()

    // 31 days later only newer scans count (old was not scanned since), and gone's key was deleted
    await scan('3', 31 * 24 * 60, { web: { ret: debian }, gone: { ret: debian } })
    const svc = new VulnService(db, schema, osv.client, { now: () => NOW + 31 * 86400_000, minions: async () => ['web', 'old'] })
    const { report } = await svc.get()
    expect(report!.minions.map((m) => [m.minion, m.jid])).toEqual([['web', '3']])
  })

  it('keeps what it knows when OSV.dev is unreachable', async () => {
    const { db, schema, scan } = await setup()
    const debian = inventory('debian\t12\t12', 'openssl\t3.0.11-1~deb12u2\tlibssl3')
    await scan('1', 0, { web: { ret: debian } })
    const down = new OsvClient('https://osv.test', async () => {
      throw new Error('getaddrinfo ENOTFOUND osv.test')
    })
    const { report } = await new VulnService(db, schema, down, { now: () => NOW }).get()
    expect(report!.error).toMatch(/Couldn't ask OSV.dev about the packages: getaddrinfo ENOTFOUND/)
    expect(report!.unchecked).toBe(1)
    expect(report!.minions[0].findings).toEqual([])
  })

  it('reports that it is still working when building takes longer than the wait', async () => {
    const { db, schema, scan } = await setup()
    await scan('1', 0, { web: { ret: inventory('debian\t12\t12', 'openssl\t3.0.11-1~deb12u2\tlibssl3') } })
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const osv = fakeOsv(affects, records)
    const slow = new OsvClient('https://osv.test', async (url, init) => {
      await gate
      return osv.fetchFn(url, init)
    })
    const svc = new VulnService(db, schema, slow, { now: () => NOW })
    expect(await svc.get(10)).toEqual({ report: null, updating: true })
    release()
    const done = await svc.get()
    expect(done.updating).toBe(false)
    expect(done.report!.minions[0].findings.map((f) => f.vuln.id)).toEqual(['DEBIAN-CVE-2024-1'])
  })
})

describe.each(testDialects)('vulnerability API (%s)', (dialect) => {
  let close: (() => Promise<unknown>) | null = null
  afterEach(async () => {
    await close?.()
    close = null
  })

  it('reports per minion and per vulnerability, to signed-in users with a role', async () => {
    const opened = await openTestDatabase(dialect)
    close = opened.close
    const { db, schema } = opened
    const args = JSON.stringify([INVENTORY_SCRIPT, { __kwarg__: true, ...INVENTORY_KWARG }])
    const at = new Date(NOW - 3600_000)
    await db.insert(schema.job).values({ jid: '1', fun: 'cmd.run', args, target: '*', targetType: 'glob', minions: '[]', startedAt: at })
    const debian = inventory('debian\t12\t12', 'openssl\t3.0.11-1~deb12u2\tlibssl3', 'bash\t5.2.15-2\tbash')
    await db.insert(schema.jobReturn).values([
      { jid: '1', minion: 'web', ret: JSON.stringify(debian), retcode: 0, success: true, returnedAt: at },
      { jid: '1', minion: 'db', ret: JSON.stringify(inventory('debian\t12\t12', 'bash\t5.2.15-2\tbash')), retcode: 0, success: true, returnedAt: at },
    ])
    const svc = new VulnService(db, schema, fakeOsv({ 'openssl@3.0.11-1~deb12u2': ['DEBIAN-CVE-2024-1'], 'bash@5.2.15-2': ['DEBIAN-CVE-2024-2'] }, {
      'DEBIAN-CVE-2024-1': { id: 'DEBIAN-CVE-2024-1', details: 'Bad thing', severity: [{ type: 'CVSS_V3', score: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H' }], affected: [{ package: { name: 'openssl', ecosystem: 'Debian:12' }, ranges: [{ type: 'ECOSYSTEM', events: [{ introduced: '0' }, { fixed: '3.0.15-1~deb12u1' }] }] }] },
      'DEBIAN-CVE-2024-2': { id: 'DEBIAN-CVE-2024-2', details: 'Unfixed thing', affected: [{ ecosystem_specific: { urgency: 'unimportant' } }] },
    }).client, { now: () => NOW })
    const app = new Hono<Env>()
    app.use('*', async (c, next) => {
      const [name, role] = (c.req.header('x-user') ?? '').split(':')
      c.set('user', name ? { id: name, name, username: name, role } : null)
      await next()
    })
    app.route('/api', vulnRoutes({ vulns: svc }))
    const get = async (path: string, user = 'ann:viewer') => {
      const res = await app.request(`/api${path}`, { headers: { 'x-user': user } })
      return { status: res.status, body: (await res.json()) as Record<string, unknown> }
    }

    expect((await get('/vulns', '')).status).toBe(401)
    expect((await get('/vulns/minions/web', 'bob:none')).status).toBe(403)

    const all = await get('/vulns')
    expect(all.status).toBe(200)
    expect(all.body.vulns).toEqual([
      { id: 'DEBIAN-CVE-2024-1', cves: [], severity: 'critical', score: 9.8, summary: 'Bad thing', packages: ['openssl'], minions: 1, fixable: 1 },
      { id: 'DEBIAN-CVE-2024-2', cves: [], severity: 'low', score: null, summary: 'Unfixed thing', packages: ['bash'], minions: 2, fixable: 0 },
    ])
    expect((all.body.minions as { minion: string; counts: object }[]).map((m) => [m.minion, m.counts])).toEqual([
      ['db', { critical: 0, high: 0, medium: 0, low: 1, unknown: 0, fixable: 0 }],
      ['web', { critical: 1, high: 0, medium: 0, low: 1, unknown: 0, fixable: 1 }],
    ])
    expect((await get('/vulns?only=minions&wait=0')).body.vulns).toEqual([])

    const web = await get('/vulns/minions/web')
    expect((web.body.findings as { id: string; fixed: string | null }[]).map((f) => [f.id, f.fixed])).toEqual([
      ['DEBIAN-CVE-2024-1', '3.0.15-1~deb12u1'],
      ['DEBIAN-CVE-2024-2', null],
    ])
    expect((await get('/vulns/minions/nope')).status).toBe(404)
    const byId = await get(`/vulns/by-id/${encodeURIComponent('DEBIAN-CVE-2024-2')}`)
    expect((byId.body.minions as { minion: string }[]).map((m) => m.minion)).toEqual(['db', 'web'])
    expect((await get('/vulns/by-id/X-1')).status).toBe(404)

    // what a scheduled scan reports
    const { report } = await svc.get()
    const summary = vulnScanSummary(report!, '1', 3)
    expect(summary).toEqual({ scanned: 2, notCovered: 0, affected: 1, critical: 1, high: 0, fixable: 1, noreturn: 1 })
    expect(vulnMessage('nightly', '*', summary, null)).toMatchObject({ title: 'Vulnerabilities "nightly": 1 critical on 1 minion, 1 with a fix', severity: 'error', lines: ['Target: *', '1 minion did not return'] })
    expect(vulnMessage('nightly', '*', { ...summary, critical: 0, affected: 0, fixable: 0 }, null).title).toBe('Vulnerabilities "nightly": nothing critical or high on 2 minions')
  })
})
