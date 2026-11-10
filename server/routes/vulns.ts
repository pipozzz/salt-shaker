import { Hono } from 'hono'
import { findingsCsv, type FindingRow } from '../../src/lib/export'
import type { AuditRow, Env } from '../types'
import { SEVERITIES, severityCounts, type Acceptance, type Finding, type MinionVulns, type VulnInfo, type VulnService } from '../vulns'

const RANK = Object.fromEntries(SEVERITIES.map((s, i) => [s, i])) as Record<string, number>

const vulnFields = ({ id, cves, severity, score, summary }: VulnInfo) => ({ id, cves, severity, score, summary })
const minionFields = ({ findings, ...m }: MinionVulns) => ({ ...m, counts: severityCounts(findings) })
const acceptanceFields = (a: Acceptance) => ({ note: a.note, acceptedBy: a.acceptedBy, acceptedAt: a.acceptedAt, expiresAt: a.expiresAt })
const findingFields = (f: Finding) => ({ ...vulnFields(f.vuln), package: f.package, version: f.version, binaries: f.binaries, fixed: f.fixed })

/** The vulnerability report, for everyone signed in. Scans themselves are ordinary jobs. */
export function vulnRoutes({ vulns, audit = async () => {} }: { vulns: VulnService; audit?: (row: AuditRow) => Promise<unknown> }) {
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
    // the accepted ones, with where they're still found
    const found = new Map<string, { vuln: VulnInfo; minions: Set<string>; packages: Set<string> }>()
    for (const m of got.all?.minions ?? []) {
      for (const f of m.findings) {
        if (!got.accepted.has(f.vuln.id)) continue
        const e = found.get(f.vuln.id) ?? { vuln: f.vuln, minions: new Set(), packages: new Set() }
        e.minions.add(m.minion)
        e.packages.add(f.package)
        found.set(f.vuln.id, e)
      }
    }
    const accepted = [...got.accepted.values()]
      .map((a) => {
        const e = found.get(a.vulnId)
        return { id: a.vulnId, vuln: e ? vulnFields(e.vuln) : null, packages: e ? [...e.packages].sort() : [], minions: e?.minions.size ?? 0, ...acceptanceFields(a) }
      })
      .sort((a, b) => +b.acceptedAt - +a.acceptedAt)
    return c.json({ ...status(got), minions: minions.map(minionFields).sort((a, b) => a.minion.localeCompare(b.minion)), vulns: list, accepted })
  })

  const writer = (c: { get: (k: 'user') => Env['Variables']['user'] }) => {
    const u = c.get('user')!
    return u.role === 'admin' || u.role === 'operator' ? (u.username ?? u.name) : null
  }
  // accepting a risk is a security decision: who did it, and who tried, goes in the audit log
  const record = (c: { get: (k: 'user') => Env['Variables']['user'] }, fun: string, target: string, outcome: string, extra: Partial<AuditRow> = {}) => {
    const u = c.get('user')!
    return audit({ userId: u.id, username: u.username ?? u.name, role: u.role, client: 'console', fun, target, outcome, ...extra })
  }

  /** Accept the risk of a vulnerability: { id, note, days? }. Operators and admins. */
  r.post('/vulns/accepted', async (c) => {
    const by = writer(c)
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
    const id = typeof body.id === 'string' ? body.id.trim() : ''
    if (!by) {
      const error = 'Only operators and admins can accept vulnerabilities'
      await record(c, 'vulns.accept', id.slice(0, 200), 'denied', { error })
      return c.json({ error }, 403)
    }
    const note = typeof body.note === 'string' ? body.note.trim() : ''
    const days = body.days == null ? null : Number(body.days)
    if (!id || id.length > 200) return c.json({ error: 'A vulnerability id is required' }, 400)
    if (!note || note.length > 1000) return c.json({ error: 'Say why the risk is accepted (max 1000 characters)' }, 400)
    if (days !== null && !(Number.isInteger(days) && days >= 1 && days <= 3650)) return c.json({ error: 'days must be a whole number from 1 to 3650' }, 400)
    const now = new Date()
    const a: Acceptance = { vulnId: id, note, acceptedBy: by, acceptedAt: now, expiresAt: days ? new Date(+now + days * 86400_000) : null }
    await vulns.accept(a)
    await record(c, 'vulns.accept', id, 'ok', { args: JSON.stringify({ note, days }) })
    return c.json({ accepted: { id, ...acceptanceFields(a) } }, 201)
  })

  r.delete('/vulns/accepted/:id', async (c) => {
    const id = c.req.param('id')
    if (!writer(c)) {
      const error = 'Only operators and admins can withdraw an acceptance'
      await record(c, 'vulns.unaccept', id, 'denied', { error })
      return c.json({ error }, 403)
    }
    if (!(await vulns.unaccept(id))) return c.json({ error: 'Not accepted' }, 404)
    await record(c, 'vulns.unaccept', id, 'ok')
    return c.json({ ok: true })
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
   * Waits for a report that's being built only as long as ?wait= says (ms, at most 60s).
   */
  r.get('/vulns/fixes', async (c) => {
    const got = await vulns.get(Math.min(Number(c.req.query('wait')) || 0, 60_000))
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

  /** The report's daily totals (accepted vulnerabilities left out), oldest first: ?days=90 (at most 730). */
  r.get('/vulns/trend', async (c) => {
    const days = Math.min(Math.max(Number(c.req.query('days')) || 90, 1), 730)
    return c.json({ days: await vulns.trend(days) })
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
    for (const m of got.all?.minions ?? []) {
      for (const f of m.findings) {
        if (f.vuln.id !== id) continue
        vuln = f.vuln
        affected.push({ minion: m.minion, package: f.package, version: f.version, binaries: f.binaries, fixed: f.fixed })
      }
    }
    if (!vuln) return c.json({ error: 'Not found on any minion' }, 404)
    affected.sort((a, b) => a.minion.localeCompare(b.minion) || a.package.localeCompare(b.package))
    const a = got.accepted.get(id)
    return c.json({ ...status(got), vuln: vulnFields(vuln), minions: affected, acceptance: a ? acceptanceFields(a) : null })
  })

  return r
}
