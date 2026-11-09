import { Hono } from 'hono'
import { findingsCsv, type FindingRow } from '../../src/lib/export'
import type { Env } from '../types'
import { SEVERITIES, severityCounts, type Finding, type MinionVulns, type VulnInfo, type VulnService } from '../vulns'

const RANK = Object.fromEntries(SEVERITIES.map((s, i) => [s, i])) as Record<string, number>

const vulnFields = ({ id, cves, severity, score, summary }: VulnInfo) => ({ id, cves, severity, score, summary })
const minionFields = ({ findings, ...m }: MinionVulns) => ({ ...m, counts: severityCounts(findings) })
const findingFields = (f: Finding) => ({ ...vulnFields(f.vuln), package: f.package, version: f.version, binaries: f.binaries, fixed: f.fixed })

/** The vulnerability report, for everyone signed in. Scans themselves are ordinary jobs. */
export function vulnRoutes({ vulns }: { vulns: VulnService }) {
  const r = new Hono<Env>()

  // only these paths: a '*' here would apply to every /api route mounted after this one
  for (const path of ['/vulns', '/vulns/*']) {
    r.use(path, async (c, next) => {
      const user = c.get('user')
      if (!user) return c.json({ error: 'Not signed in' }, 401)
      if (user.role === 'none') return c.json({ error: 'No role' }, 403)
      await next()
    })
  }

  const status = (report: Awaited<ReturnType<VulnService['get']>>) => ({
    updating: report.updating,
    progress: report.updating ? vulns.progress : null,
    builtAt: report.report?.builtAt ?? null,
    error: report.report?.error ?? null,
    unchecked: report.report?.unchecked ?? 0,
  })

  /** Per-minion counts and every vulnerability found, worst and most widespread first. */
  r.get('/vulns', async (c) => {
    // ?wait=0 answers right away with what's there; ?only=minions leaves out the vulnerability list
    const wait = c.req.query('wait')
    const got = await vulns.get(wait === undefined ? 20_000 : Math.min(Number(wait) || 0, 60_000))
    const minions = got.report?.minions ?? []
    if (c.req.query('only') === 'minions') return c.json({ ...status(got), minions: minions.map(minionFields).sort((a, b) => a.minion.localeCompare(b.minion)), vulns: [] })
    const byId = new Map<string, { vuln: VulnInfo; packages: Set<string>; minions: Set<string>; fixable: Set<string> }>()
    for (const m of minions) {
      for (const f of m.findings) {
        const e = byId.get(f.vuln.id) ?? { vuln: f.vuln, packages: new Set(), minions: new Set(), fixable: new Set() }
        e.packages.add(f.package)
        e.minions.add(m.minion)
        if (f.fixed) e.fixable.add(m.minion)
        byId.set(f.vuln.id, e)
      }
    }
    const list = [...byId.values()]
      .map((e) => ({ ...vulnFields(e.vuln), packages: [...e.packages].sort(), minions: e.minions.size, fixable: e.fixable.size }))
      .sort((a, b) => RANK[a.severity] - RANK[b.severity] || b.minions - a.minions || (b.score ?? 0) - (a.score ?? 0) || a.id.localeCompare(b.id))
    return c.json({ ...status(got), minions: minions.map(minionFields).sort((a, b) => a.minion.localeCompare(b.minion)), vulns: list })
  })

  /** Every finding as CSV, with the page's filters: ?severity=critical,high&fix=1&q=openssl */
  r.get('/vulns/export', async (c) => {
    const got = await vulns.get()
    const severities = (c.req.query('severity') ?? '').split(',').filter(Boolean)
    const fixOnly = c.req.query('fix') === '1'
    const q = (c.req.query('q') ?? '').toLowerCase()
    const rows: FindingRow[] = []
    for (const m of got.report?.minions ?? []) {
      for (const f of m.findings) {
        if (severities.length && !severities.includes(f.vuln.severity)) continue
        if (fixOnly && !f.fixed) continue
        if (q && ![m.minion, f.package, f.vuln.id, f.vuln.summary, ...f.vuln.cves].some((x) => x.toLowerCase().includes(q))) continue
        rows.push({ minion: m.minion, os: m.os, scannedAt: m.scannedAt, ...findingFields(f) })
      }
    }
    rows.sort((a, b) => a.minion.localeCompare(b.minion) || RANK[a.severity] - RANK[b.severity] || a.package.localeCompare(b.package) || a.id.localeCompare(b.id))
    const name = `vulnerabilities-${new Date().toISOString().slice(0, 10)}.csv`
    return c.body(findingsCsv(rows), 200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${name}"`, 'Cache-Control': 'no-store' })
  })

  /**
   * Per minion, the installed packages that have a fixed version for a known vulnerability, for the
   * Patches page to compare with the version on offer: { web-01: { ecosystem, packages: { libssl3:
   * [{ id, severity, fixed }] } } }. Keyed by binary package, as pkg.list_upgrades names them.
   * Never waits for a report that's being built.
   */
  r.get('/vulns/fixes', async (c) => {
    const got = await vulns.get(0)
    const out: Record<string, { ecosystem: string | null; packages: Record<string, Array<{ id: string; severity: string; fixed: string }>> }> = {}
    for (const m of got.report?.minions ?? []) {
      for (const f of m.findings) {
        if (!f.fixed) continue
        const e = (out[m.minion] ??= { ecosystem: m.ecosystem, packages: {} })
        for (const b of f.binaries) (e.packages[b] ??= []).push({ id: f.vuln.id, severity: f.vuln.severity, fixed: f.fixed })
      }
    }
    return c.json({ ...status(got), minions: out })
  })

  /** What was found on one minion. */
  r.get('/vulns/minions/:id', async (c) => {
    const got = await vulns.get()
    const m = got.report?.minions.find((x) => x.minion === c.req.param('id'))
    if (!m) return c.json({ error: 'This minion has no inventory yet' }, 404)
    const findings = m.findings.map(findingFields).sort((a, b) => RANK[a.severity] - RANK[b.severity] || a.package.localeCompare(b.package) || a.id.localeCompare(b.id))
    return c.json({ ...status(got), minion: minionFields(m), findings })
  })

  /** The minions one vulnerability was found on. */
  r.get('/vulns/by-id/:id', async (c) => {
    const got = await vulns.get()
    const id = c.req.param('id')
    let vuln: VulnInfo | null = null
    const affected: Array<{ minion: string; package: string; version: string; binaries: string[]; fixed: string | null }> = []
    for (const m of got.report?.minions ?? []) {
      for (const f of m.findings) {
        if (f.vuln.id !== id) continue
        vuln = f.vuln
        affected.push({ minion: m.minion, package: f.package, version: f.version, binaries: f.binaries, fixed: f.fixed })
      }
    }
    if (!vuln) return c.json({ error: 'Not found on any minion' }, 404)
    affected.sort((a, b) => a.minion.localeCompare(b.minion) || a.package.localeCompare(b.package))
    return c.json({ ...status(got), vuln: vulnFields(vuln), minions: affected })
  })

  return r
}
