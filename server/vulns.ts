import { and, desc, eq, gte, inArray, like, sql } from 'drizzle-orm'
import { INVENTORY_MARKER } from '../src/lib/inventory'
import type { Db, Schema } from './db'

/*
 * Known vulnerabilities in the packages installed on minions. An inventory job (cmd.run with
 * INVENTORY_SCRIPT) lists each minion's packages; this module matches them against OSV.dev, which
 * gathers the distributions' own security trackers, and caches what it learns in the database.
 */

export const SEVERITIES = ['critical', 'high', 'medium', 'low', 'unknown'] as const
export type Severity = (typeof SEVERITIES)[number]

export interface Package {
  /** source package on Debian, Ubuntu and Alpine; the package itself on RPM systems */
  name: string
  version: string
  /** installed packages built from it */
  binaries: string[]
}

export interface Inventory {
  os: { id: string; versionId: string; version: string }
  ecosystem: string | null
  packages: Package[]
}

/** Reads the inventory script's output; null when it isn't one (e.g. an error message). */
export function parseInventory(out: unknown): Inventory | null {
  if (typeof out !== 'string') return null
  let os: Inventory['os'] | null = null
  const pkgs = new Map<string, Package>()
  for (const line of out.split('\n')) {
    const f = line.replace(/\r$/, '').split('\t')
    if (f[0] === 'os' && !os) os = { id: f[1] ?? '', versionId: f[2] ?? '', version: f[3] ?? '' }
    else if (f[0] === 'pkg' && f[1] && f[2]) {
      const key = `${f[1]}\0${f[2]}`
      const p = pkgs.get(key) ?? { name: f[1], version: f[2], binaries: [] }
      if (f[3] && !p.binaries.includes(f[3])) p.binaries.push(f[3])
      pkgs.set(key, p)
    }
  }
  if (!os) return null
  return { os, ecosystem: ecosystemFor(os.id, os.versionId, os.version), packages: [...pkgs.values()] }
}

/** The OSV ecosystem of a distribution release, from /etc/os-release; null if OSV doesn't cover it. */
export function ecosystemFor(id: string, versionId: string, version = ''): string | null {
  const major = versionId.split('.')[0]
  switch (id) {
    case 'debian':
      return /^\d+$/.test(major) ? `Debian:${major}` : null
    case 'ubuntu':
      return /^\d+\.\d+$/.test(versionId) ? `Ubuntu:${versionId}${/LTS/.test(version) ? ':LTS' : ''}` : null
    case 'almalinux':
      return /^\d+$/.test(major) ? `AlmaLinux:${major}` : null
    case 'rocky':
      return /^\d+$/.test(major) ? `Rocky Linux:${major}` : null
    case 'alpine': {
      const m = versionId.match(/^(\d+\.\d+)/)
      return m ? `Alpine:v${m[1]}` : null
    }
    default:
      return null
  }
}

/** The CVSS v3.x base score of a vector like CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H. */
export function cvss3Score(vector: string): number | null {
  if (!/^CVSS:3\.[01]\//.test(vector)) return null
  const m = Object.fromEntries(vector.split('/').slice(1).map((p) => p.split(':') as [string, string]))
  const AV = { N: 0.85, A: 0.62, L: 0.55, P: 0.2 }[m.AV]
  const AC = { L: 0.77, H: 0.44 }[m.AC]
  const UI = { N: 0.85, R: 0.62 }[m.UI]
  const scope = m.S
  const PR = (scope === 'C' ? { N: 0.85, L: 0.68, H: 0.5 } : { N: 0.85, L: 0.62, H: 0.27 })[m.PR as 'N']
  const cia = { H: 0.56, L: 0.22, N: 0 }
  const C = cia[m.C as 'H']
  const I = cia[m.I as 'H']
  const A = cia[m.A as 'H']
  if ([AV, AC, UI, PR, C, I, A].some((x) => x === undefined) || (scope !== 'U' && scope !== 'C')) return null
  const iss = 1 - (1 - C) * (1 - I) * (1 - A)
  const impact = scope === 'U' ? 6.42 * iss : 7.52 * (iss - 0.029) - 3.25 * (iss - 0.02) ** 15
  if (impact <= 0) return 0
  const exploit = 8.22 * AV! * AC! * PR * UI!
  const raw = scope === 'U' ? Math.min(impact + exploit, 10) : Math.min(1.08 * (impact + exploit), 10)
  // CVSS 3.1 "round up" to one decimal, avoiding floating point surprises
  const i = Math.round(raw * 100000)
  return i % 10000 === 0 ? i / 100000 : (Math.floor(i / 10000) + 1) / 10
}

export const scoreSeverity = (s: number): Severity => (s >= 9 ? 'critical' : s >= 7 ? 'high' : s >= 4 ? 'medium' : s > 0 ? 'low' : 'unknown')

/** What the console shows of an OSV record. */
export interface VulnInfo {
  id: string
  summary: string
  /** CVE ids it covers */
  cves: string[]
  severity: Severity
  /** CVSS v3 base score, when the record has a vector */
  score: number | null
  /** first fixed version per `ecosystem|package` */
  fixed: Record<string, string>
}

interface OsvRecord {
  id: string
  summary?: string
  details?: string
  aliases?: string[]
  upstream?: string[]
  severity?: { type: string; score: string }[]
  affected?: {
    package?: { name: string; ecosystem: string }
    ranges?: { type: string; events: Record<string, string>[] }[]
    ecosystem_specific?: { urgency?: string }
  }[]
}

const DISTRO_RATING: Record<string, Severity> = { critical: 'critical', important: 'high', high: 'high', moderate: 'medium', medium: 'medium', low: 'low', negligible: 'low', unimportant: 'low' }

/** Bumped when vulnInfo() changes, so cached records are read from OSV.dev again. */
const INFO_VERSION = 1

/** The parts of an OSV record we keep, with one severity for it. */
export function vulnInfo(r: OsvRecord): VulnInfo {
  const cves = [...new Set([...(r.upstream ?? []), ...(r.aliases ?? []), r.id].filter((x) => /^CVE-\d+-\d+$/.test(x)))]
  const vector = r.severity?.find((s) => s.type === 'CVSS_V3')?.score
  const score = vector ? cvss3Score(vector) : null
  // the distribution's own rating first: it accounts for how the package is built and used there
  // (Debian marks disputed or irrelevant CVEs "unimportant", whatever their CVSS score)
  const ubuntu = r.severity?.find((s) => s.type === 'Ubuntu')?.score.toLowerCase()
  const prefix = r.summary?.match(/^(Critical|Important|Moderate|Low):/)?.[1].toLowerCase()
  const urgency = r.affected?.map((a) => a.ecosystem_specific?.urgency?.replace(/\*+$/, '').toLowerCase()).find((u) => u && u in DISTRO_RATING)
  const severity = (ubuntu && DISTRO_RATING[ubuntu]) || (prefix && DISTRO_RATING[prefix]) || (urgency && DISTRO_RATING[urgency]) || (score !== null ? scoreSeverity(score) : undefined) || 'unknown'
  const fixed: Record<string, string> = {}
  for (const a of r.affected ?? []) {
    if (!a.package) continue
    for (const range of a.ranges ?? []) {
      if (range.type !== 'ECOSYSTEM') continue
      const f = range.events.map((e) => e.fixed).filter(Boolean).at(-1)
      if (f) fixed[`${a.package.ecosystem}|${a.package.name}`] = f
    }
  }
  const text = (r.summary || (r.details ?? '').replace(/^Issue summary:\s*/i, '')).replace(/\s+/g, ' ').trim()
  return { id: r.id, summary: text.length > 240 ? `${text.slice(0, 237)}…` : text, cves, severity, score, fixed }
}

/**
 * Advisories that repeat per-CVE records of the same tracker (Debian DSA/DLA, Ubuntu USN): counting
 * both would list each problem twice.
 */
const isDuplicateAdvisory = (id: string) => /^(DSA|DLA|DTSA|USN)-/.test(id)

export interface OsvRef {
  id: string
  modified: string
}

export interface OsvQuery {
  ecosystem: string
  name: string
  version: string
}

type Fetch = (url: string, init?: RequestInit) => Promise<Response>

/** The bits of the OSV.dev API we use. */
export class OsvClient {
  constructor(
    private base = 'https://api.osv.dev',
    private fetchFn: Fetch = fetch,
  ) {}

  private async post<T>(path: string, body: unknown): Promise<T> {
    const res = await this.fetchFn(`${this.base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(60_000) })
    if (!res.ok) throw new Error(`OSV.dev answered ${res.status} for ${path}`)
    return (await res.json()) as T
  }

  /** The vulnerabilities affecting each package version, in the order asked. */
  async query(queries: OsvQuery[]): Promise<OsvRef[][]> {
    const out: OsvRef[][] = []
    for (let i = 0; i < queries.length; i += 1000) {
      const chunk = queries.slice(i, i + 1000)
      const body = { queries: chunk.map((q) => ({ package: { name: q.name, ecosystem: q.ecosystem }, version: q.version })) }
      const res = await this.post<{ results: { vulns?: OsvRef[]; next_page_token?: string }[] }>('/v1/querybatch', body)
      for (const [j, r] of res.results.entries()) {
        const refs = [...(r.vulns ?? [])]
        // a package with very many vulnerabilities is paged; the rest comes from the single query
        let token = r.next_page_token
        while (token) {
          const more = await this.post<{ vulns?: { id: string; modified?: string }[]; next_page_token?: string }>('/v1/query', { ...body.queries[j], page_token: token })
          refs.push(...(more.vulns ?? []).map((v) => ({ id: v.id, modified: v.modified ?? '' })))
          token = more.next_page_token
        }
        out.push(refs)
      }
    }
    return out
  }

  async vuln(id: string): Promise<OsvRecord> {
    const res = await this.fetchFn(`${this.base}/v1/vulns/${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(30_000) })
    if (!res.ok) throw new Error(`OSV.dev answered ${res.status} for ${id}`)
    return (await res.json()) as OsvRecord
  }
}

export interface Finding {
  vuln: VulnInfo
  package: string
  version: string
  binaries: string[]
  /** the first version with the fix, when there is one */
  fixed: string | null
}

export interface MinionVulns {
  minion: string
  jid: string
  scannedAt: Date
  /** e.g. "debian 12" */
  os: string | null
  ecosystem: string | null
  packages: number
  /** why the minion has no results: the scan failed or OSV doesn't cover its OS */
  error: string | null
  findings: Finding[]
}

export interface Acceptance {
  vulnId: string
  note: string
  acceptedBy: string | null
  acceptedAt: Date
  expiresAt: Date | null
}

/** The report without the accepted vulnerabilities. */
export function withoutAccepted(report: VulnReport, accepted: Map<string, Acceptance>): VulnReport {
  if (!accepted.size) return report
  return { ...report, minions: report.minions.map((m) => ({ ...m, findings: m.findings.filter((f) => !accepted.has(f.vuln.id)) })) }
}

export type VulnTotals = Record<Severity, number> & { fixable: number; minions: number; affected: number }

/** Distinct vulnerabilities by severity and with a fix, and how many scanned minions have any. */
export function vulnTotals(report: VulnReport): VulnTotals {
  const seen = new Map<string, Severity>()
  const fixable = new Set<string>()
  let minions = 0
  let affected = 0
  for (const m of report.minions) {
    if (m.error) continue
    minions++
    if (m.findings.length) affected++
    for (const f of m.findings) {
      seen.set(f.vuln.id, f.vuln.severity)
      if (f.fixed) fixable.add(f.vuln.id)
    }
  }
  const t = { critical: 0, high: 0, medium: 0, low: 0, unknown: 0, fixable: fixable.size, minions, affected }
  for (const sev of seen.values()) t[sev]++
  return t
}

export interface VulnReport {
  builtAt: Date
  minions: MinionVulns[]
  /** set when OSV.dev couldn't be reached; what's shown then comes from the cache */
  error: string | null
  /** package versions OSV.dev was never asked about (it couldn't be reached) */
  unchecked: number
}

/** A minion's inventory job return, without the (large) output. */
export interface ScanRef {
  minion: string
  jid: string
  startedAt: Date
  ok: boolean
}

const chunks = <T>(xs: T[], n: number) => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n))

/**
 * Each minion's latest inventory since `since`: the newest one that succeeded, or its newest failure
 * when none did. Only metadata is read, so this is cheap enough to run on every request.
 */
export async function latestScans(db: Db, schema: Schema, since: Date): Promise<ScanRef[]> {
  const t = schema.job
  const r = schema.jobReturn
  const jobs = await db
    .select({ jid: t.jid, startedAt: t.startedAt })
    .from(t)
    .where(and(eq(t.fun, 'cmd.run'), gte(t.startedAt, since), like(t.args, `%${INVENTORY_MARKER}%`)))
    .orderBy(desc(t.startedAt))
    .limit(1000)
  if (!jobs.length) return []
  const startedAt = new Map(jobs.map((j) => [j.jid, j.startedAt]))
  const rows: { jid: string; minion: string; retcode: number | null }[] = []
  for (const c of chunks([...startedAt.keys()], 500)) rows.push(...(await db.select({ jid: r.jid, minion: r.minion, retcode: r.retcode }).from(r).where(inArray(r.jid, c))))
  // newest first, so a minion's latest good inventory wins, and its latest failure shows when it never had one
  const all = rows.map((x) => ({ minion: x.minion, jid: x.jid, startedAt: startedAt.get(x.jid)!, ok: !x.retcode })).sort((a, b) => +b.startedAt - +a.startedAt)
  const out = new Map<string, ScanRef>()
  for (const s of all) {
    const prev = out.get(s.minion)
    if (!prev || (!prev.ok && s.ok)) out.set(s.minion, s)
  }
  return [...out.values()]
}

interface Parsed {
  inventory: Inventory | null
  error: string | null
}

/** Reads and parses the output of the given inventory returns. */
async function loadInventories(db: Db, schema: Schema, scans: ScanRef[]) {
  const r = schema.jobReturn
  const wanted = new Set(scans.map((s) => `${s.jid}|${s.minion}`))
  const out = new Map<string, Parsed>()
  for (const c of chunks([...new Set(scans.map((s) => s.jid))], 200)) {
    const rows = await db.select({ jid: r.jid, minion: r.minion, ret: r.ret, retcode: r.retcode }).from(r).where(inArray(r.jid, c))
    for (const x of rows) {
      const key = `${x.jid}|${x.minion}`
      if (!wanted.has(key)) continue
      let value: unknown = null
      try {
        value = x.ret ? JSON.parse(x.ret) : null
      } catch {
        value = null
      }
      const inventory = !x.retcode ? parseInventory(value) : null
      out.set(key, { inventory, error: inventory ? null : typeof value === 'string' && value.trim() ? value.trim().split('\n')[0].slice(0, 200) : 'The scan returned nothing usable' })
    }
  }
  return out
}

async function pool<T>(items: T[], n: number, fn: (item: T) => Promise<void>) {
  let i = 0
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) await fn(items[i++])
  }))
}

export interface VulnServiceOptions {
  /** how long OSV's answer for a package version is trusted before asking again */
  packageTtlMs?: number
  /** how long a report is reused when no new inventory came in */
  reportTtlMs?: number
  /** inventories older than this are left out (minions that are gone, or no longer scanned) */
  windowDays?: number
  /** the accepted minions; others (keys deleted since) are left out. Null when unknown. */
  minions?: () => Promise<string[] | null>
  now?: () => number
}

/**
 * Builds the vulnerability report from the latest inventories and OSV.dev, caching OSV's answers in
 * the database. Building can take a while the first time (every vulnerability record is fetched
 * once), so callers wait a bounded time and show the previous report meanwhile.
 */
export class VulnService {
  private report: (VulnReport & { key: string }) | null = null
  private building: Promise<VulnReport> | null = null
  progress: { step: 'packages' | 'vulns'; done: number; total: number } | null = null
  private packageTtlMs: number
  private reportTtlMs: number
  private windowMs: number
  private minions: () => Promise<string[] | null>
  private now: () => number
  /** parsed inventories by `jid|minion`, so a rebuild only reads new ones */
  private parsed = new Map<string, Parsed>()

  constructor(
    private db: Db,
    private schema: Schema,
    private osv: OsvClient,
    opts: VulnServiceOptions = {},
  ) {
    this.packageTtlMs = opts.packageTtlMs ?? 12 * 3600_000
    this.reportTtlMs = opts.reportTtlMs ?? 3600_000
    this.windowMs = (opts.windowDays ?? 30) * 86400_000
    this.minions = opts.minions ?? (async () => null)
    this.now = opts.now ?? Date.now
  }

  /** Acceptances that haven't expired, by vulnerability id. */
  async accepted(): Promise<Map<string, Acceptance>> {
    const rows = await this.db.select().from(this.schema.vulnAcceptance)
    const now = this.now()
    return new Map(rows.filter((r) => !r.expiresAt || +r.expiresAt > now).map((r) => [r.vulnId, r]))
  }

  /** Accepts the risk of a vulnerability on every minion, replacing an earlier acceptance. */
  async accept(a: Acceptance) {
    const t = this.schema.vulnAcceptance
    await this.db.insert(t).values(a).onConflictDoUpdate({ target: t.vulnId, set: { note: a.note, acceptedBy: a.acceptedBy, acceptedAt: a.acceptedAt, expiresAt: a.expiresAt } })
  }

  async unaccept(vulnId: string): Promise<boolean> {
    const t = this.schema.vulnAcceptance
    const gone = await this.db.delete(t).where(eq(t.vulnId, vulnId)).returning({ id: t.vulnId })
    return gone.length > 0
  }

  /**
   * The current report without the accepted vulnerabilities (`all` has them too), rebuilt when new
   * inventories came in or it's old, waiting at most `waitMs`.
   */
  async get(waitMs = 20_000): Promise<{ report: VulnReport | null; all: VulnReport | null; accepted: Map<string, Acceptance>; updating: boolean }> {
    const [got, accepted] = await Promise.all([this.current(waitMs), this.accepted()])
    const report = got.report && withoutAccepted(got.report, accepted)
    if (report) await this.record(report).catch((e) => console.warn('vulns: recording the daily totals failed', e))
    return { ...got, all: got.report, report, accepted }
  }

  private recorded = ''

  /** Keeps today's totals (UTC) for the trend; written only when they change. */
  private async record(report: VulnReport) {
    // an incomplete report (OSV unreachable) or one without inventories says nothing about the trend
    if (report.error || !report.minions.length) return
    const day = new Date(this.now()).toISOString().slice(0, 10)
    const totals = vulnTotals(report)
    const key = `${day}|${JSON.stringify(totals)}`
    if (key === this.recorded) return
    const t = this.schema.vulnDaily
    await this.db.insert(t).values({ day, ...totals }).onConflictDoUpdate({ target: t.day, set: totals })
    this.recorded = key
  }

  /** The daily totals of the last `days` days, oldest first. */
  async trend(days: number): Promise<Array<VulnTotals & { day: string }>> {
    const t = this.schema.vulnDaily
    const since = new Date(this.now() - days * 86400_000).toISOString().slice(0, 10)
    return this.db.select().from(t).where(gte(t.day, since)).orderBy(t.day)
  }

  private async current(waitMs: number): Promise<{ report: VulnReport | null; updating: boolean }> {
    let scans = await latestScans(this.db, this.schema, new Date(this.now() - this.windowMs))
    const accepted = await this.minions().catch(() => null)
    if (accepted) {
      const keep = new Set(accepted)
      scans = scans.filter((s) => keep.has(s.minion))
    }
    const key = scans.map((s) => `${s.minion}:${s.jid}`).sort().join(',')
    const fresh = this.report && this.report.key === key && this.now() - +this.report.builtAt < this.reportTtlMs
    if (!fresh && !this.building) {
      this.building = this.build(scans, key).finally(() => {
        this.building = null
        this.progress = null
      })
      // a failed build keeps the previous report; the error is in the next one
      this.building.catch((e) => console.warn('vulns: building the report failed', e))
    }
    if (this.building) {
      const done = await Promise.race([this.building.then(() => true, () => true), new Promise<false>((r) => setTimeout(() => r(false), waitMs))])
      return { report: this.report, updating: !done }
    }
    return { report: this.report, updating: false }
  }

  private async build(scans: ScanRef[], key: string): Promise<VulnReport> {
    const { db, schema } = this
    let error: string | null = null

    // only inventories not parsed before are read from the database
    const fresh = await loadInventories(db, schema, scans.filter((s) => !this.parsed.has(`${s.jid}|${s.minion}`)))
    const parsed = new Map<string, Parsed>()
    for (const s of scans) {
      const k = `${s.jid}|${s.minion}`
      parsed.set(k, this.parsed.get(k) ?? fresh.get(k) ?? { inventory: null, error: 'The scan returned nothing usable' })
    }
    this.parsed = parsed
    const inventories = scans.map((scan) => ({ scan, ...parsed.get(`${scan.jid}|${scan.minion}`)! }))

    // every package version in the fleet, once
    const wanted = new Map<string, OsvQuery>()
    for (const i of inventories) {
      const eco = i.inventory?.ecosystem
      if (!eco) continue
      for (const p of i.inventory!.packages) wanted.set(`${eco}|${p.name}|${p.version}`, { ecosystem: eco, name: p.name, version: p.version })
    }

    // what OSV said before, and what to ask again
    const ecosystems = [...new Set([...wanted.values()].map((q) => q.ecosystem))]
    const known = new Map<string, OsvRef[]>()
    const stale: OsvQuery[] = []
    if (ecosystems.length) {
      const rows = await db.select().from(schema.osvPackage).where(inArray(schema.osvPackage.ecosystem, ecosystems))
      const byKey = new Map(rows.map((r) => [`${r.ecosystem}|${r.name}|${r.version}`, r]))
      for (const [k, q] of wanted) {
        const row = byKey.get(k)
        if (row) known.set(k, JSON.parse(row.vulns) as OsvRef[])
        if (!row || this.now() - +row.fetchedAt > this.packageTtlMs) stale.push(q)
      }
    }
    if (stale.length) {
      try {
        this.progress = { step: 'packages', done: 0, total: stale.length }
        const answers = await this.osv.query(stale)
        const fetchedAt = new Date(this.now())
        const rows = stale.map((q, i) => ({ ...q, vulns: JSON.stringify(answers[i] ?? []), fetchedAt }))
        for (const c of chunks(rows, 200)) {
          await db
            .insert(schema.osvPackage)
            .values(c)
            .onConflictDoUpdate({ target: [schema.osvPackage.ecosystem, schema.osvPackage.name, schema.osvPackage.version], set: { vulns: sql`excluded.vulns`, fetchedAt: sql`excluded.fetched_at` } })
        }
        stale.forEach((q, i) => known.set(`${q.ecosystem}|${q.name}|${q.version}`, answers[i] ?? []))
        this.progress = { step: 'packages', done: stale.length, total: stale.length }
      } catch (e) {
        error = `Couldn't ask OSV.dev about the packages: ${e instanceof Error ? e.message : String(e)}`
      }
    }

    // the vulnerability records, fetched once and again only when OSV says they changed
    const refs = new Map<string, string>()
    for (const list of known.values()) for (const r of list) if (!isDuplicateAdvisory(r.id)) refs.set(r.id, r.modified)
    const infos = new Map<string, VulnInfo>()
    const missing: string[] = []
    for (const c of chunks([...refs.keys()], 500)) {
      const rows = await db.select().from(schema.osvVuln).where(inArray(schema.osvVuln.id, c))
      const have = new Set<string>()
      for (const r of rows) {
        const data = JSON.parse(r.data) as VulnInfo & { v?: number }
        infos.set(r.id, data)
        if (r.modified === refs.get(r.id) && data.v === INFO_VERSION) have.add(r.id)
      }
      for (const id of c) if (!have.has(id)) missing.push(id)
    }
    if (missing.length) {
      this.progress = { step: 'vulns', done: 0, total: missing.length }
      const failures: string[] = []
      await pool(missing, 8, async (id) => {
        try {
          const info = vulnInfo(await this.osv.vuln(id))
          const row = { id, modified: refs.get(id)!, data: JSON.stringify({ ...info, v: INFO_VERSION }), fetchedAt: new Date(this.now()) }
          await db.insert(schema.osvVuln).values(row).onConflictDoUpdate({ target: schema.osvVuln.id, set: row })
          infos.set(id, info)
        } catch (e) {
          failures.push(e instanceof Error ? e.message : String(e))
        }
        this.progress!.done++
      })
      if (failures.length && !error) error = `Couldn't fetch ${failures.length} of ${missing.length} vulnerability records from OSV.dev: ${failures[0]}`
    }

    let unchecked = 0
    const minions: MinionVulns[] = inventories.map(({ scan, inventory, error: scanError }) => {
      const base = { minion: scan.minion, jid: scan.jid, scannedAt: scan.startedAt, os: inventory ? `${inventory.os.id} ${inventory.os.versionId}`.trim() : null, ecosystem: inventory?.ecosystem ?? null, packages: inventory?.packages.length ?? 0 }
      if (!inventory) return { ...base, error: scanError, findings: [] }
      if (!inventory.ecosystem) return { ...base, error: `OSV.dev has no vulnerability data for ${base.os || 'this OS'}`, findings: [] }
      const eco = inventory.ecosystem
      const findings: Finding[] = []
      for (const p of inventory.packages) {
        const list = known.get(`${eco}|${p.name}|${p.version}`)
        if (!list) {
          unchecked++
          continue
        }
        for (const ref of list) {
          const vuln = infos.get(ref.id)
          if (!vuln) continue
          findings.push({ vuln, package: p.name, version: p.version, binaries: p.binaries, fixed: vuln.fixed[`${eco}|${p.name}`] ?? null })
        }
      }
      return { ...base, error: null, findings }
    })

    const report = { key, builtAt: new Date(this.now()), minions, error, unchecked }
    this.report = report
    return report
  }
}

export function severityCounts(findings: Finding[]) {
  const counts = Object.fromEntries(SEVERITIES.map((s) => [s, 0])) as Record<Severity, number>
  const seen = new Set<string>()
  let fixable = 0
  for (const f of findings) {
    if (seen.has(f.vuln.id)) continue
    seen.add(f.vuln.id)
    counts[f.vuln.severity]++
    if (f.fixed) fixable++
  }
  return { ...counts, fixable }
}

/** What a scheduled scan found on the minions that answered it: its notification and summary. */
export interface VulnScanSummary {
  scanned: number
  notCovered: number
  /** minions with a critical or high vulnerability */
  affected: number
  critical: number
  high: number
  /** critical and high vulnerabilities with a fixed version available */
  fixable: number
  noreturn: number
}

export function vulnScanSummary(report: VulnReport, jid: string, expected: number): VulnScanSummary {
  const mine = report.minions.filter((m) => m.jid === jid)
  const serious = new Map<string, { severity: Severity; fixed: boolean }>()
  let affected = 0
  for (const m of mine) {
    let hit = false
    for (const f of m.findings) {
      if (f.vuln.severity !== 'critical' && f.vuln.severity !== 'high') continue
      hit = true
      const prev = serious.get(f.vuln.id)
      serious.set(f.vuln.id, { severity: f.vuln.severity, fixed: !!prev?.fixed || !!f.fixed })
    }
    if (hit) affected++
  }
  const all = [...serious.values()]
  return {
    scanned: mine.filter((m) => !m.error).length,
    notCovered: mine.filter((m) => m.error).length,
    affected,
    critical: all.filter((v) => v.severity === 'critical').length,
    high: all.filter((v) => v.severity === 'high').length,
    fixable: all.filter((v) => v.fixed).length,
    noreturn: Math.max(0, expected - mine.length),
  }
}
