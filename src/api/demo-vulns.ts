import type { FindingRow } from '../lib/export'
import type { InstalledPackage, PackageSearch, Severity, SeverityCounts, Vuln, VulnAccepted, VulnAcceptance, VulnAffected, VulnDay, VulnFinding, VulnFixes, VulnMinion, VulnStatus, VulnSummary } from './server'

/*
 * The demo's vulnerability report. The real one is built by the server from package inventories
 * and OSV.dev; here it's a fixed, made-up set (DEMO-… ids) over the demo minions.
 */

type Hit = [minion: string, version: string, fixed: string | null, binaries: string[]]
interface DemoVuln extends Vuln {
  package: string
  hits: Hit[]
}

const ubuntu24 = (v: string) => `${v}ubuntu0.24.04.1`
const DEMO: DemoVuln[] = [
  {
    id: 'DEMO-2026-0101',
    cves: [],
    severity: 'critical',
    score: 9.8,
    summary: 'A crafted TLS handshake can overflow a heap buffer in the certificate parser and run code in the server process.',
    package: 'openssl',
    hits: [
      ['web-01', '3.0.13-0ubuntu3.4', '3.0.13-0ubuntu3.5', ['libssl3t64', 'openssl']],
      ['web-02', '3.0.13-0ubuntu3.4', '3.0.13-0ubuntu3.5', ['libssl3t64', 'openssl']],
      ['db-01', '3.0.15-1~deb12u1', '3.0.16-1~deb12u1', ['libssl3', 'openssl']],
    ],
  },
  {
    id: 'DEMO-2026-0144',
    cves: [],
    severity: 'high',
    score: 8.1,
    summary: 'Request smuggling through malformed chunked encoding when nginx proxies to an HTTP/1.1 upstream.',
    package: 'nginx',
    hits: [
      ['web-01', '1.24.0-2ubuntu7', '1.24.0-2ubuntu7.1', ['nginx', 'nginx-common']],
      ['web-02', '1.24.0-2ubuntu7.1', null, ['nginx', 'nginx-common']],
    ],
  },
  {
    id: 'DEMO-2026-0187',
    cves: [],
    severity: 'high',
    score: 7.8,
    summary: 'A local user can gain root through a race in the sudoedit temporary file handling.',
    package: 'sudo',
    hits: [
      ['web-01', ubuntu24('1.9.15p5-3'), ubuntu24('1.9.15p5-3.1'), ['sudo']],
      ['web-02', ubuntu24('1.9.15p5-3'), ubuntu24('1.9.15p5-3.1'), ['sudo']],
      ['worker-01', '1.9.9-1ubuntu2.4', '1.9.9-1ubuntu2.5', ['sudo']],
      ['mon-01', '1.9.5p2-10.el9_3', '1.9.5p2-10.el9_5', ['sudo']],
    ],
  },
  {
    id: 'DEMO-2026-0219',
    cves: [],
    severity: 'medium',
    score: 5.5,
    summary: 'A local user can crash the kernel through a use-after-free in the netfilter connection tracker.',
    package: 'kernel',
    hits: [['mon-01', '5.14.0-503.11.1.el9_5', '5.14.0-503.15.1.el9_5', ['kernel', 'kernel-core']]],
  },
  {
    id: 'DEMO-2026-0203',
    cves: [],
    severity: 'medium',
    score: 6.5,
    summary: 'A malicious server can make libcurl leak credentials to another host after a redirect.',
    package: 'curl',
    hits: [
      ['db-01', '7.88.1-10+deb12u8', '7.88.1-10+deb12u9', ['curl', 'libcurl4']],
      ['cache-01', '7.88.1-10+deb12u8', '7.88.1-10+deb12u9', ['curl', 'libcurl4']],
      ['worker-01', '7.81.0-1ubuntu1.18', null, ['curl', 'libcurl4']],
    ],
  },
  {
    id: 'DEMO-2026-0230',
    cves: [],
    severity: 'medium',
    score: 5.3,
    summary: 'Authenticated users can read other roles’ statistics through an unchecked view in PostgreSQL.',
    package: 'postgresql-15',
    hits: [['db-01', '15.8-0+deb12u1', '15.10-0+deb12u1', ['postgresql-15', 'postgresql-client-15']]],
  },
  {
    id: 'DEMO-2025-0912',
    cves: [],
    severity: 'low',
    score: 3.3,
    summary: 'tar can follow a symlink outside the target directory when extracting with --keep-directory-symlink.',
    package: 'tar',
    hits: ['web-01', 'web-02', 'db-01', 'cache-01', 'worker-01'].map((m): Hit => [m, '1.35+dfsg-3', null, ['tar']]),
  },
  {
    id: 'DEMO-2025-0977',
    cves: [],
    severity: 'unknown',
    score: null,
    summary: 'Not yet rated: a crafted regular expression can make grep use excessive memory.',
    package: 'grep',
    hits: [['mon-01', '3.6-5.el9', null, ['grep']]],
  },
]

const SCANNED: Record<string, { os: string; ecosystem: string; packages: number; hoursAgo: number }> = {
  'web-01': { os: 'ubuntu 24.04', ecosystem: 'Ubuntu:24.04:LTS', packages: 612, hoursAgo: 3 },
  'web-02': { os: 'ubuntu 24.04', ecosystem: 'Ubuntu:24.04:LTS', packages: 609, hoursAgo: 3 },
  'db-01': { os: 'debian 12', ecosystem: 'Debian:12', packages: 488, hoursAgo: 3 },
  'cache-01': { os: 'debian 12', ecosystem: 'Debian:12', packages: 402, hoursAgo: 51 },
  'mon-01': { os: 'rocky 9.4', ecosystem: 'Rocky Linux:9', packages: 431, hoursAgo: 3 },
  'worker-01': { os: 'ubuntu 22.04', ecosystem: 'Ubuntu:22.04:LTS', packages: 655, hoursAgo: 3 },
}

// packages every demo minion has, besides the vulnerable ones above: [name, Debian/Ubuntu version, RPM version]
const COMMON: Array<[string, string, string, string[]]> = [
  ['bash', '5.2.21-2ubuntu4', '5.1.8-9.el9', ['bash']],
  ['coreutils', '9.4-3ubuntu6', '8.32-35.el9', ['coreutils']],
  ['openssh', '1:9.6p1-3ubuntu13.5', '8.7p1-43.el9', ['openssh-client', 'openssh-server']],
  ['python3.12', '3.12.3-1ubuntu0.3', '3.9.19-8.el9', ['python3.12', 'libpython3.12-minimal']],
  ['systemd', '255.4-1ubuntu8.4', '252-46.el9', ['systemd', 'libsystemd0']],
  ['zlib', '1:1.3.dfsg-3.1ubuntu2.1', '1.2.11-40.el9', ['zlib1g']],
]

const LEVELS: Severity[] = ['critical', 'high', 'medium', 'low', 'unknown']
const RANK = Object.fromEntries(LEVELS.map((s, i) => [s, i])) as Record<Severity, number>
const status = (): VulnStatus => ({ updating: false, progress: null, builtAt: new Date(Date.now() - 2 * 60_000).toISOString(), error: null, unchecked: 0 })
const fields = ({ id, cves, severity, score, summary }: Vuln): Vuln => ({ id, cves, severity, score, summary })

function minionRow(minion: string): VulnMinion {
  const s = SCANNED[minion]
  const counts = Object.fromEntries([...LEVELS, 'fixable'].map((k) => [k, 0])) as SeverityCounts
  for (const v of visible()) {
    const hit = v.hits.find((h) => h[0] === minion)
    if (!hit) continue
    counts[v.severity]++
    if (hit[2]) counts.fixable++
  }
  return { minion, jid: '20261109080000000000', scannedAt: new Date(Date.now() - s.hoursAgo * 3600_000).toISOString(), os: s.os, ecosystem: s.ecosystem, packages: s.packages, error: null, counts }
}

/** accepted in this browser session; the demo forgets them on reload */
const accepted = new Map<string, VulnAcceptance>()
const visible = () => DEMO.filter((v) => !accepted.has(v.id))

const delay = <T>(v: T) => new Promise<T>((r) => setTimeout(() => r(v), 150))

export const demoVulns = {
  report: () => {
    const list: VulnSummary[] = visible().map((v) => ({ ...fields(v), packages: [v.package], minions: v.hits.length, fixable: v.hits.filter((h) => h[2]).length }))
    list.sort((a, b) => RANK[a.severity] - RANK[b.severity] || b.minions - a.minions)
    const acc: VulnAccepted[] = [...accepted].map(([id, a]) => {
      const v = DEMO.find((x) => x.id === id)!
      return { id, vuln: fields(v), packages: [v.package], minions: v.hits.length, ...a }
    })
    return delay({ ...status(), minions: Object.keys(SCANNED).sort().map(minionRow), vulns: list, accepted: acc })
  },
  minions: () => delay({ ...status(), minions: Object.keys(SCANNED).sort().map(minionRow) }),
  minion: (id: string) => {
    if (!SCANNED[id]) return Promise.reject(new Error('This minion has no inventory yet'))
    const findings: VulnFinding[] = visible().flatMap((v) => v.hits.filter((h) => h[0] === id).map(([, version, fixed, binaries]) => ({ ...fields(v), package: v.package, version, fixed, binaries })))
    return delay({ ...status(), minion: minionRow(id), findings })
  },
  /** every finding, for the CSV export */
  findings: (): FindingRow[] =>
    visible().flatMap((v) => v.hits.map(([minion, version, fixed, binaries]) => ({ minion, os: SCANNED[minion].os, scannedAt: minionRow(minion).scannedAt, package: v.package, binaries, version, ...fields(v), fixed }))).sort(
      (a, b) => a.minion.localeCompare(b.minion) || RANK[a.severity] - RANK[b.severity],
    ),
  byId: (id: string) => {
    const v = DEMO.find((x) => x.id === id)
    if (!v) return Promise.reject(new Error('Not found on any minion'))
    const minions: VulnAffected[] = v.hits.map(([minion, version, fixed, binaries]) => ({ minion, package: v.package, version, fixed, binaries }))
    return delay({ ...status(), vuln: fields(v), minions, acceptance: accepted.get(id) ?? null })
  },
  fixes: (_wait = 0) => {
    const out: VulnFixes = {}
    for (const v of visible()) {
      for (const [minion, , fixed, binaries] of v.hits) {
        if (!fixed) continue
        const e = (out[minion] ??= { ecosystem: SCANNED[minion].ecosystem, packages: {} })
        for (const b of binaries) (e.packages[b] ??= []).push({ id: v.id, severity: v.severity, fixed })
      }
    }
    return delay({ ...status(), minions: out })
  },
  packages: (q: string) => {
    const needle = q.toLowerCase()
    const groups = new Map<string, InstalledPackage>()
    const add = (minion: string, name: string, version: string, binaries: string[]) => {
      if (!name.toLowerCase().includes(needle) && !binaries.some((b) => b.toLowerCase().includes(needle))) return
      const s = SCANNED[minion]
      const g = groups.get(`${s.ecosystem}|${name}|${version}`) ?? { name, version, ecosystem: s.ecosystem, os: s.os, binaries, minions: [] }
      g.minions.push(minion)
      groups.set(`${s.ecosystem}|${name}|${version}`, g)
    }
    for (const minion of Object.keys(SCANNED).sort()) {
      const rpm = SCANNED[minion].ecosystem.startsWith('Rocky')
      for (const v of DEMO) for (const [m, version, , binaries] of v.hits) if (m === minion) add(minion, v.package, version, binaries)
      for (const [name, deb, rpmVersion, binaries] of COMMON) add(minion, name, rpm ? rpmVersion : deb, rpm ? [name] : binaries)
    }
    const list = [...groups.values()].sort((a, b) => a.name.localeCompare(b.name) || (a.os ?? '').localeCompare(b.os ?? '') || b.version.localeCompare(a.version))
    return delay<PackageSearch>({ updating: false, total: list.length, minions: new Set(list.flatMap((g) => g.minions)).size, packages: list.slice(0, 200) })
  },
  /** a made-up history ending in today's demo totals: a bad month, then patching catches up */
  trend: (days = 90) => {
    const today = DEMO.reduce((t, v) => ({ ...t, [v.severity]: t[v.severity] + 1, fixable: t.fixable + (v.hits.some((h) => h[2]) ? 1 : 0) }), { critical: 0, high: 0, medium: 0, low: 0, unknown: 0, fixable: 0 } as Record<Severity | 'fixable', number>)
    const n = Math.min(days, 60)
    const out: VulnDay[] = []
    for (let i = n - 1; i >= 0; i--) {
      // a wave of advisories three to five weeks ago, fixed over the following days
      const wave = i > 35 ? 0 : i > 22 ? Math.round((35 - i) / 3) : Math.max(0, Math.round((i - 8) / 3))
      out.push({
        day: new Date(Date.now() - i * 86400_000).toISOString().slice(0, 10),
        critical: today.critical + (wave > 2 ? 1 : 0),
        high: today.high + Math.ceil(wave / 2),
        medium: today.medium + wave,
        low: today.low,
        unknown: today.unknown,
        fixable: today.fixable + Math.ceil(wave * 0.8),
        minions: 6,
        affected: 6,
      })
    }
    return delay({ days: out })
  },
  accept: (id: string, note: string, days: number | null) => {
    const at = new Date()
    const a = { note, acceptedBy: 'demo', acceptedAt: at.toISOString(), expiresAt: days ? new Date(+at + days * 86400_000).toISOString() : null }
    accepted.set(id, a)
    return delay({ accepted: { id, ...a } })
  },
  unaccept: (id: string) => {
    accepted.delete(id)
    return delay({ ok: true as const })
  },
}
