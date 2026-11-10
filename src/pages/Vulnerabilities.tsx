import clsx from 'clsx'
import { ChevronRight, Download, ExternalLink, Play, RefreshCw, Search, Server, ShieldAlert, ShieldCheck, ShieldOff, Undo2, Wrench } from 'lucide-react'
import { useEffect, useState, type FormEvent } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { demoVulns } from '../api/demo-vulns'
import { vulns as serverVulns, type Severity, type SeverityCounts, type Vuln, type VulnAccepted, type VulnFinding, type VulnMinion, type VulnSummary } from '../api/server'
import type { TargetType } from '../api/types'
import { TargetField } from '../components/TargetField'
import { VulnTrend } from '../components/VulnTrend'
import { Badge, Button, ButtonLink, Card, CardHeader, Empty, ErrorBox, Input, Modal, PageHeader, PermNote, Select, Spinner, Stat, Tabs, type Tone } from '../components/ui'
import { relTime } from '../lib/format'
import { useAsync } from '../lib/hooks'
import { download, findingsCsv } from '../lib/export'
import { INVENTORY_KWARG, INVENTORY_SCRIPT } from '../lib/inventory'
import { useCan, useSession } from '../lib/session'
import { useJob } from '../lib/useJob'

const SEVERITY: Record<Severity, { tone: Tone; label: string }> = {
  critical: { tone: 'red', label: 'Critical' },
  high: { tone: 'amber', label: 'High' },
  medium: { tone: 'blue', label: 'Medium' },
  low: { tone: 'zinc', label: 'Low' },
  unknown: { tone: 'zinc', label: 'Unrated' },
}
const LEVELS = ['critical', 'high', 'medium', 'low', 'unknown'] as const
const FILTERS = ['all', 'critical', 'high', 'medium', 'low'] as const
const PAGE = 100

export function SeverityBadge({ severity, score }: { severity: Severity; score?: number | null }) {
  const s = SEVERITY[severity]
  return (
    <Badge tone={s.tone} className="whitespace-nowrap" title={score ? `CVSS ${score.toFixed(1)}. The rating is the distribution's own when it has one, so it can differ from the score.` : undefined}>
      {s.label}
      {score ? ` ${score.toFixed(1)}` : ''}
    </Badge>
  )
}

/** "3 critical · 12 high", worst first; the rest go in the tooltip. */
export function CountsBadges({ counts }: { counts: SeverityCounts }) {
  const shown = LEVELS.filter((l) => counts[l] > 0)
  if (!shown.length) return <Badge tone="green">none known</Badge>
  return (
    <span className="flex flex-wrap gap-1" title={shown.map((l) => `${counts[l]} ${SEVERITY[l].label.toLowerCase()}`).join(', ') + ` · ${counts.fixable} with a fix`}>
      {shown.slice(0, 2).map((l) => (
        <Badge key={l} tone={SEVERITY[l].tone}>
          {counts[l]} {SEVERITY[l].label.toLowerCase()}
        </Badge>
      ))}
      {shown.length > 2 && <Badge>+{shown.slice(2).reduce((n, l) => n + counts[l], 0)}</Badge>}
    </span>
  )
}

function VulnLink({ v }: { v: Pick<Vuln, 'id' | 'cves'> }) {
  // the demo's made-up ids have no page on OSV.dev
  if (v.id.startsWith('DEMO-')) return <span className="font-mono text-xs font-medium">{v.id}</span>
  return (
    <span className="flex flex-col">
      <a href={`https://osv.dev/vulnerability/${encodeURIComponent(v.id)}`} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} className="inline-flex items-center gap-1 font-mono text-xs font-medium hover:text-accent-600">
        {v.id} <ExternalLink className="size-3" />
      </a>
      {v.cves.length > 0 && !v.cves.some((c) => v.id.endsWith(c)) && <span className="font-mono text-[11px] text-zinc-500 dark:text-zinc-400">{v.cves.slice(0, 3).join(', ') + (v.cves.length > 3 ? ` +${v.cves.length - 3}` : '')}</span>}
    </span>
  )
}

/** Pre-fills Run with an upgrade of the vulnerable packages on the minions that have a fix. */
function upgradeUrl(minions: string[], pkgs: string[]) {
  const args = `pkgs='${JSON.stringify([...new Set(pkgs)].sort())}' only_upgrade=True`
  return `/run?tgt=${encodeURIComponent(minions.join(','))}&tgt_type=list&fun=pkg.install&args=${encodeURIComponent(args)}`
}

/** The server's report, or the demo's made-up one. */
function useVulnApi() {
  const { session } = useSession()
  return session?.mode === 'demo' ? demoVulns : serverVulns
}

/** The demo has no server to build the CSV, so it's made here, with the same filters. */
function exportDemo(f: { severity?: string; fix: boolean; q?: string }) {
  const q = (f.q ?? '').toLowerCase()
  const rows = demoVulns
    .findings()
    .filter((r) => (!f.severity || r.severity === f.severity) && (!f.fix || r.fixed) && (!q || [r.minion, r.package, r.id, r.summary].some((x) => x.toLowerCase().includes(q))))
  download(`vulnerabilities-${new Date().toISOString().slice(0, 10)}.csv`, 'text/csv', findingsCsv(rows))
}

export function VulnerabilitiesPage() {
  const vulns = useVulnApi()
  const { session } = useSession()
  const demo = session?.mode === 'demo'
  const can = useCan()
  const canScan = can('local', 'cmd.run')
  const canUpgrade = can('local', 'pkg.install')
  // accepting a risk is a team decision: operators and admins, on the server's own accounts
  const canAccept = demo || (session?.mode === 'server' && (session.eauth === 'admin' || session.eauth === 'operator'))
  const scan = useJob()
  const [tgt, setTgt] = useState('*')
  const [tgtType, setTgtType] = useState<TargetType>('glob')
  const [scanError, setScanError] = useState<Error | null>(null)
  const [params, setParams] = useSearchParams()
  const VIEWS = ['minions', 'accepted', 'packages'] as const
  const view = VIEWS.find((v) => v === params.get('view')) ?? 'vulns'
  const filter = FILTERS.find((f) => f === params.get('severity')) ?? 'all'
  const fixOnly = params.get('fix') === '1'
  const query = params.get('q') ?? ''
  const update = (changes: Record<string, string | null>) =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev)
        for (const [k, v] of Object.entries(changes)) {
          if (v) next.set(k, v)
          else next.delete(k)
        }
        return next
      },
      { replace: true },
    )

  const [reloads, setReloads] = useState(0)
  // a finished scan brings new inventories
  const scanDone = !!scan.run?.done
  const report = useAsync(() => vulns.report(), [vulns, reloads, scanDone])
  const trend = useAsync(() => vulns.trend(90).catch(() => ({ days: [] })), [vulns, reloads, scanDone])
  const data = report.data
  // the server keeps building in the background; ask again until it's done
  useEffect(() => {
    if (!data?.updating) return
    const t = setTimeout(() => setReloads((n) => n + 1), 3000)
    return () => clearTimeout(t)
  }, [data])

  const startScan = async (e: FormEvent) => {
    e.preventDefault()
    setScanError(null)
    try {
      await scan.start(tgt, tgtType, 'cmd.run', [INVENTORY_SCRIPT], { ...INVENTORY_KWARG })
    } catch (err) {
      setScanError(err as Error)
    }
  }

  const q = query.toLowerCase()
  // cheap enough to compute on every render, even for thousands of rows
  const list = (data?.vulns ?? []).filter(
    (v) =>
      (filter === 'all' || v.severity === filter) &&
      (!fixOnly || v.fixable > 0) &&
      (!q || v.id.toLowerCase().includes(q) || v.cves.some((c) => c.toLowerCase().includes(q)) || v.packages.some((p) => p.toLowerCase().includes(q)) || v.summary.toLowerCase().includes(q)),
  )
  const minions = (data?.minions ?? [])
    .filter((m) => !q || m.minion.toLowerCase().includes(q) || (m.os ?? '').includes(q))
    .filter((m) => filter === 'all' || m.counts[filter] > 0)
    .filter((m) => !fixOnly || m.counts.fixable > 0)
    .sort((a, b) => worst(b.counts) - worst(a.counts) || a.minion.localeCompare(b.minion))
  const acceptedList = (data?.accepted ?? []).filter((a) => !q || a.id.toLowerCase().includes(q) || a.note.toLowerCase().includes(q) || a.packages.some((p) => p.toLowerCase().includes(q)))
  const changed = () => setReloads((n) => n + 1)
  const soon = (data?.accepted ?? []).filter((a) => a.expiresAt && expiresSoon(a.expiresAt)).length
  const filterKey = `${view}|${filter}|${fixOnly}|${q}`
  const [paging, setPaging] = useState({ key: '', count: PAGE })
  const count = paging.key === filterKey ? paging.count : PAGE

  const all = data?.vulns ?? []
  const scanned = data?.minions.filter((m) => !m.error) ?? []
  const affected = scanned.filter((m) => LEVELS.some((l) => m.counts[l] > 0)).length
  const lastScan = data?.minions.reduce<string | null>((a, m) => (!a || m.scannedAt > a ? m.scannedAt : a), null)
  // the export has the filters of the page
  const exportFilter = { severity: filter === 'all' ? undefined : filter, fix: fixOnly, q: query || undefined }
  const filtered = filter !== 'all' || fixOnly || !!query
  const run = scan.run
  const scanning = !!run && !run.done

  return (
    <>
      <PageHeader
        title="Vulnerabilities"
        description={
          <>
            Known vulnerabilities in the packages installed on your minions, from the distributions' security trackers via{' '}
            <a href="https://osv.dev" target="_blank" rel="noreferrer" className="text-accent-700 hover:underline dark:text-accent-400">
              OSV.dev
            </a>
            .
          </>
        }
        actions={
          <>
            {data && data.minions.length > 0 && (
              demo ? (
                <Button icon={<Download className="size-4" />} onClick={() => exportDemo(exportFilter)}>
                  Export CSV
                </Button>
              ) : (
                <ButtonLink href={serverVulns.exportUrl(exportFilter)} download icon={<Download className="size-4" />} title={filtered ? 'Exports the findings the filters match' : 'Every finding, one row per minion and package'}>
                  Export CSV
                </ButtonLink>
              )
            )}
            <Button icon={<RefreshCw className={clsx('size-4', report.loading && 'animate-spin')} />} onClick={() => setReloads((n) => n + 1)} disabled={report.loading}>
              Refresh
            </Button>
          </>
        }
      />

      <Card className="mb-6">
        <form onSubmit={startScan} className="flex flex-wrap items-start gap-3 p-4">
          <div className="min-w-64 flex-1">
            <TargetField
              tgt={tgt}
              tgtType={tgtType}
              onChange={(t, tt) => {
                setTgt(t)
                setTgtType(tt)
              }}
            />
          </div>
          <Button type="submit" variant="primary" className="sm:mt-[22px]" icon={<Search className="size-4" />} loading={scanning} disabled={!canScan}>
            {run && !run.done ? `Scanning… ${Object.keys(run.results).length}/${run.minions.length}` : 'Scan packages'}
          </Button>
        </form>
        {!canScan && <PermNote className="px-4 pb-3">Your account cannot scan; the inventory runs a shell script with cmd.run.</PermNote>}
        <p className="border-t border-zinc-100 px-4 py-2 text-xs text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
          A scan lists the installed packages (dpkg, rpm or apk) and changes nothing. The server then checks them against OSV.dev. Debian, Ubuntu, AlmaLinux, Rocky Linux and Alpine are covered.
          {lastScan && <> Latest inventory {relTime(new Date(lastScan))}.</>}
          {scan.run && (
            <>
              {' '}
              <Link to={`/jobs/${scan.run.jid}`} className="font-mono hover:text-accent-600">
                jid {scan.run.jid}
              </Link>
            </>
          )}
        </p>
      </Card>

      {(scanError || report.error) && (
        <div className="mb-6">
          <ErrorBox error={(scanError ?? report.error)!} onRetry={report.error ? () => setReloads((n) => n + 1) : undefined} />
        </div>
      )}
      {data?.error && (
        <p className="mb-6 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-300">
          {data.error}. {data.unchecked > 0 ? `${data.unchecked} package versions couldn't be checked; ` : ''}The results below may be incomplete.
        </p>
      )}

      {!data && report.loading && <Spinner label="Loading the report…" />}
      {data?.updating && (
        <Card className="mb-6">
          <Spinner
            label={
              data.progress?.step === 'vulns'
                ? `Fetching vulnerability records from OSV.dev… ${data.progress.done}/${data.progress.total}`
                : data.progress
                  ? `Asking OSV.dev about ${data.progress.total} package versions…`
                  : 'Checking packages against OSV.dev…'
            }
          />
        </Card>
      )}

      {data && !data.updating && data.minions.length === 0 && (
        <Card>
          <Empty icon={<ShieldCheck />} title="No package inventory yet">
            Scan a target to list each minion's packages; known vulnerabilities in them show up here. A{' '}
            <Link to="/schedules" className="text-accent-700 hover:underline dark:text-accent-400">
              schedule
            </Link>{' '}
            of kind <em>Vulnerability scan</em> keeps them current.
          </Empty>
        </Card>
      )}

      {data && data.minions.length > 0 && (
        <>
          <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label="Critical" value={all.filter((v) => v.severity === 'critical').length} icon={<ShieldAlert />} tone={all.some((v) => v.severity === 'critical') ? 'red' : 'zinc'} />
            <Stat label="High" value={all.filter((v) => v.severity === 'high').length} icon={<ShieldAlert />} tone={all.some((v) => v.severity === 'high') ? 'amber' : 'zinc'} />
            <Stat label="With a fix available" value={all.filter((v) => v.fixable > 0).length} icon={<Wrench />} tone="accent" hint={`of ${all.length} known`} />
            <Stat label="Minions affected" value={`${affected}/${scanned.length}`} icon={<Server />} tone="zinc" hint={data.minions.length > scanned.length ? `${data.minions.length - scanned.length} not covered` : undefined} />
          </div>

          {(trend.data?.days.length ?? 0) >= 2 && (
            <Card className="mb-6">
              <CardHeader title="Last 90 days" subtitle="Distinct vulnerabilities each day, accepted ones left out" />
              <div className="p-4">
                <VulnTrend days={trend.data!.days} />
              </div>
            </Card>
          )}

          <Card>
            <div className="flex flex-wrap items-center gap-3 border-b border-zinc-200 p-3 dark:border-zinc-800">
              <Tabs
                value={view}
                onChange={(v) => update({ view: v === 'vulns' ? null : v })}
                items={[
                  { value: 'vulns', label: 'By vulnerability' },
                  { value: 'minions', label: 'By minion' },
                  { value: 'packages', label: 'Installed packages' },
                  ...(data.accepted.length || view === 'accepted' ? [{ value: 'accepted' as const, label: `Accepted (${data.accepted.length})${soon ? ` · ${soon} expiring` : ''}` }] : []),
                ]}
              />
              <div className="relative min-w-48 flex-1">
                <Search className="pointer-events-none absolute top-2.5 left-3 size-4 text-zinc-500 dark:text-zinc-400" />
                <Input value={query} onChange={(e) => update({ q: e.target.value })} placeholder={view === 'vulns' ? 'Filter by CVE, package or text…' : view === 'accepted' ? 'Filter by id, package or reason…' : view === 'packages' ? 'Search installed packages, e.g. openssl…' : 'Filter minions…'} className="pl-9" />
              </div>
              {view !== 'accepted' && view !== 'packages' && (
                <>
                  <Tabs value={filter} onChange={(f) => update({ severity: f === 'all' ? null : f })} items={FILTERS.map((f) => ({ value: f, label: f === 'all' ? 'All' : SEVERITY[f].label }))} />
                  <label className="flex items-center gap-2 text-sm text-zinc-600 dark:text-zinc-400">
                    <input type="checkbox" checked={fixOnly} onChange={(e) => update({ fix: e.target.checked ? '1' : null })} className="accent-accent-600" />
                    Fix available
                  </label>
                </>
              )}
            </div>

            {view === 'packages' ? (
              <PackageSearchView q={query.trim()} />
            ) : view === 'accepted' ? (
              acceptedList.length ? (
                <AcceptedTable list={acceptedList} canAccept={canAccept} onChanged={changed} />
              ) : (
                <Empty icon={<ShieldOff />} title={data.accepted.length ? 'Nothing matches' : 'No accepted vulnerabilities'}>
                  {data.accepted.length ? 'Try a different filter.' : 'Open a vulnerability and accept its risk to leave it out of the counts, alerts and Patches.'}
                </Empty>
              )
            ) : view === 'vulns' ? (
              list.length ? (
                <VulnTable list={list.slice(0, count)} canUpgrade={canUpgrade} canAccept={canAccept} onChanged={changed} />
              ) : (
                <Empty icon={<ShieldCheck />} title={all.length ? 'Nothing matches' : 'No known vulnerabilities'}>
                  {all.length ? 'Try a different filter.' : 'OSV.dev knows of no vulnerability in the installed package versions.'}
                </Empty>
              )
            ) : minions.length ? (
              <MinionTable list={minions.slice(0, count)} />
            ) : (
              <Empty icon={<Server />} title="No minions match" />
            )}
            {(view === 'vulns' || view === 'minions') && (view === 'vulns' ? list : minions).length > count && (
              <div className="flex items-center justify-center gap-3 border-t border-zinc-100 p-3 text-sm dark:border-zinc-800">
                <span className="text-zinc-500 dark:text-zinc-400">
                  Showing {count} of {(view === 'vulns' ? list : minions).length}
                </span>
                <Button size="sm" onClick={() => setPaging({ key: filterKey, count: count + PAGE })}>
                  Show more
                </Button>
              </div>
            )}
          </Card>
          {data.builtAt && <p className="mt-3 text-xs text-zinc-500 dark:text-zinc-400">Checked against OSV.dev {relTime(new Date(data.builtAt))}.</p>}
        </>
      )}
    </>
  )
}

/** An inventory older than a week misses what was installed or upgraded since. */
const isStale = (at: string) => Date.now() - Date.parse(at) > 7 * 86400_000

const worst = (c: SeverityCounts) => c.critical * 1e6 + c.high * 1e4 + c.medium * 100 + c.low

interface AcceptProps {
  canAccept: boolean
  onChanged: () => void
}

function VulnTable({ list, canUpgrade, ...accept }: { list: VulnSummary[]; canUpgrade: boolean } & AcceptProps) {
  const [open, setOpen] = useState<string | null>(null)
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-zinc-200 text-left text-xs text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
            <th className="w-0 py-2.5 pr-1 pl-4" />
            <th className="px-3 py-2.5 font-medium">Severity</th>
            <th className="px-3 py-2.5 font-medium">Vulnerability</th>
            <th className="px-3 py-2.5 font-medium">Package</th>
            <th className="hidden px-3 py-2.5 font-medium lg:table-cell">Summary</th>
            <th className="px-3 py-2.5 pr-4 font-medium">Minions</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800/70">
          {list.map((v) => (
            <VulnRow key={v.id} v={v} open={open === v.id} onToggle={() => setOpen(open === v.id ? null : v.id)} canUpgrade={canUpgrade} {...accept} />
          ))}
        </tbody>
      </table>
    </div>
  )
}

function VulnRow({ v, open, onToggle, canUpgrade, ...accept }: { v: VulnSummary; open: boolean; onToggle: () => void; canUpgrade: boolean } & AcceptProps) {
  return (
    <>
      <tr onClick={onToggle} className="cursor-pointer align-top hover:bg-zinc-50 dark:hover:bg-zinc-800/30">
        <td className="py-2.5 pr-1 pl-4">
          <button aria-expanded={open} aria-label={`${open ? 'Hide' : 'Show'} minions with ${v.id}`} className="rounded text-zinc-400 focus-visible:outline-2 focus-visible:outline-accent-500">
            <ChevronRight className={clsx('size-4 transition', open && 'rotate-90')} />
          </button>
        </td>
        <td className="px-3 py-2.5">
          <SeverityBadge severity={v.severity} score={v.score} />
        </td>
        <td className="px-3 py-2.5">
          <VulnLink v={v} />
        </td>
        <td className="px-3 py-2.5 font-mono text-xs">{v.packages.join(', ')}</td>
        <td className="hidden max-w-md px-3 py-2.5 text-xs text-zinc-600 lg:table-cell dark:text-zinc-400">{v.summary}</td>
        <td className="px-3 py-2.5 pr-4 whitespace-nowrap">
          <Badge>{v.minions}</Badge>
          <span className="ml-1.5 text-xs text-zinc-500 dark:text-zinc-400">{v.fixable === v.minions ? 'fix available' : v.fixable ? `${v.fixable} with a fix` : 'no fix yet'}</span>
        </td>
      </tr>
      {open && (
        <tr>
          <td colSpan={6} className="bg-zinc-50/60 px-4 py-3 dark:bg-zinc-900/40">
            <Affected id={v.id} canUpgrade={canUpgrade} {...accept} />
          </td>
        </tr>
      )}
    </>
  )
}

function Affected({ id, canUpgrade, canAccept, onChanged }: { id: string; canUpgrade: boolean } & AcceptProps) {
  const vulns = useVulnApi()
  const { data, error } = useAsync(() => vulns.byId(id), [vulns, id])
  const [accepting, setAccepting] = useState(false)
  if (error) return <ErrorBox error={error} />
  if (!data) return <Spinner />
  const fixable = data.minions.filter((m) => m.fixed)
  return (
    <div className="space-y-3">
      <p className="text-sm text-zinc-700 lg:hidden dark:text-zinc-300">{data.vuln.summary}</p>
      <table className="w-full text-xs">
        <thead>
          <tr className="text-left text-zinc-500 dark:text-zinc-400">
            <th className="py-1 pr-3 font-medium">Minion</th>
            <th className="py-1 pr-3 font-medium">Installed</th>
            <th className="py-1 font-medium">Fixed in</th>
          </tr>
        </thead>
        <tbody>
          {data.minions.map((m) => (
            <tr key={`${m.minion}|${m.package}`}>
              <td className="py-1 pr-3">
                <Link to={`/minions/${encodeURIComponent(m.minion)}`} className="font-mono font-medium hover:text-accent-600">
                  {m.minion}
                </Link>
              </td>
              <td className="py-1 pr-3 font-mono text-zinc-600 dark:text-zinc-400" title={m.binaries.length ? `Installed: ${m.binaries.join(', ')}` : undefined}>
                {m.package} {m.version}
              </td>
              <td className="py-1 font-mono text-zinc-600 dark:text-zinc-400">{m.fixed ?? <span className="font-sans text-zinc-500">no fix yet</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {fixable.length > 0 && canUpgrade && (
        <Link to={upgradeUrl([...new Set(fixable.map((m) => m.minion))].sort(), fixable.flatMap((m) => (m.binaries.length ? m.binaries : [m.package])))} className="inline-flex items-center gap-1.5 rounded-lg bg-accent-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-accent-700">
          <Play className="size-3.5" /> Upgrade on {new Set(fixable.map((m) => m.minion)).size} {new Set(fixable.map((m) => m.minion)).size === 1 ? 'minion' : 'minions'}
        </Link>
      )}
      {canAccept && !data.acceptance && (
        <Button size="sm" className={clsx(fixable.length > 0 && canUpgrade && 'ml-2')} icon={<ShieldOff className="size-3.5" />} onClick={() => setAccepting(true)}>
          Accept risk…
        </Button>
      )}
      <AcceptModal id={accepting ? id : null} onClose={() => setAccepting(false)} onDone={onChanged} />
    </div>
  )
}

/** Waits until the value stops changing for a moment, so typing doesn't send a request per key. */
function useDebounced<T>(value: T, ms = 250) {
  const [v, setV] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms)
    return () => clearTimeout(t)
  }, [value, ms])
  return v
}

/** Where packages are installed, from the same inventories as the report. */
function PackageSearchView({ q }: { q: string }) {
  const vulns = useVulnApi()
  const term = useDebounced(q)
  const found = useAsync(() => (term.length >= 2 ? vulns.packages(term) : Promise.resolve(null)), [vulns, term])
  if (term.length < 2)
    return (
      <Empty icon={<Search />} title="Search the installed packages">
        Type at least two letters of a package name to see which versions are installed where, from the latest inventories. Installed package names (e.g. libssl3) match too. On Debian, Ubuntu and Alpine the name and version are the source package's, as their security trackers use them.
      </Empty>
    )
  if (found.error) return <div className="p-4"><ErrorBox error={found.error} /></div>
  if (!found.data) return <Spinner />
  const { packages, total, minions } = found.data
  if (!packages.length) return <Empty icon={<Search />} title={`No installed package matches “${term}”`} />
  return (
    <div className="overflow-x-auto">
      <p className="border-b border-zinc-100 px-4 py-2 text-xs text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
        {total} {total === 1 ? 'version' : 'versions'} on {minions} {minions === 1 ? 'minion' : 'minions'}
        {total > packages.length && <> · showing the first {packages.length}; narrow the search</>}
      </p>
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-zinc-200 text-left text-xs text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
            <th className="py-2.5 pr-3 pl-4 font-medium">Package</th>
            <th className="px-3 py-2.5 font-medium" title="The source package's version on Debian, Ubuntu and Alpine; a rebuilt binary can carry a suffix such as +b1">
              Version
            </th>
            <th className="px-3 py-2.5 font-medium">OS</th>
            <th className="px-3 py-2.5 pr-4 font-medium">Minions</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800/70">
          {packages.map((p) => (
            <tr key={`${p.ecosystem}|${p.name}|${p.version}`} className="align-top">
              <td className="py-2.5 pr-3 pl-4">
                <Link to={`/vulnerabilities?q=${encodeURIComponent(p.name)}`} className="font-mono font-medium hover:text-accent-600" title="Known vulnerabilities in this package">
                  {p.name}
                </Link>
                {p.binaries.some((b) => b !== p.name) && <div className="font-mono text-xs text-zinc-500 dark:text-zinc-400">{p.binaries.join(', ')}</div>}
              </td>
              <td className="px-3 py-2.5 font-mono text-xs">{p.version}</td>
              <td className="px-3 py-2.5 text-xs whitespace-nowrap text-zinc-600 dark:text-zinc-400">{p.os}</td>
              <td className="px-3 py-2.5 pr-4">
                <span className="flex flex-wrap items-center gap-1" title={p.minions.join(', ')}>
                  <Badge>{p.minions.length}</Badge>
                  {p.minions.slice(0, 5).map((m) => (
                    <Link key={m} to={`/minions/${encodeURIComponent(m)}?tab=vulns`} className="rounded bg-zinc-100 px-1.5 font-mono text-[11px] hover:text-accent-600 dark:bg-zinc-800">
                      {m}
                    </Link>
                  ))}
                  {p.minions.length > 5 && <span className="text-xs text-zinc-500 dark:text-zinc-400">+{p.minions.length - 5}</span>}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

const daysLeft = (at: string) => Math.max(1, Math.ceil((Date.parse(at) - Date.now()) / 86400_000))
/** an acceptance ending within a week is worth a look before the vulnerability comes back */
const expiresSoon = (at: string) => Date.parse(at) - Date.now() < 7 * 86400_000

const DURATIONS = [
  { days: 7, label: '7 days' },
  { days: 30, label: '30 days' },
  { days: 90, label: '90 days' },
  { days: 365, label: 'A year' },
  { days: 0, label: 'Until withdrawn' },
]

/** Asks why, and for how long, before accepting the risk of a vulnerability on every minion. */
function AcceptModal({ id, onClose, onDone }: { id: string | null; onClose: () => void; onDone: () => void }) {
  const vulns = useVulnApi()
  const [note, setNote] = useState('')
  const [days, setDays] = useState(90)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<Error | null>(null)
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!id) return
    setBusy(true)
    setError(null)
    try {
      await vulns.accept(id, note.trim(), days || null)
      setNote('')
      onClose()
      onDone()
    } catch (err) {
      setError(err as Error)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal open={!!id} onClose={onClose} title={`Accept the risk of ${id ?? ''}`}>
      <form onSubmit={submit} className="space-y-4 text-sm">
        <p className="text-zinc-600 dark:text-zinc-400">It drops out of the counts, the scheduled scan alerts and Patches on every minion. It stays listed under Accepted, and comes back when the acceptance expires or is withdrawn.</p>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-zinc-600 dark:text-zinc-400">Why</span>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            required
            maxLength={1000}
            rows={3}
            placeholder="e.g. The service isn't exposed; fixed in the next image rebuild."
            className="w-full rounded-lg border border-zinc-200 bg-white p-2 text-sm focus:border-accent-500 focus:outline-none dark:border-zinc-800 dark:bg-zinc-900"
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-zinc-600 dark:text-zinc-400">For</span>
          <Select value={days} onChange={(e) => setDays(Number(e.target.value))}>
            {DURATIONS.map((d) => (
              <option key={d.days} value={d.days}>
                {d.label}
              </option>
            ))}
          </Select>
        </label>
        {error && <ErrorBox error={error} />}
        <div className="flex justify-end gap-2">
          <Button type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" loading={busy} disabled={!note.trim()}>
            Accept risk
          </Button>
        </div>
      </form>
    </Modal>
  )
}

function AcceptedTable({ list, canAccept, onChanged }: { list: VulnAccepted[] } & AcceptProps) {
  const vulns = useVulnApi()
  const [error, setError] = useState<Error | null>(null)
  const withdraw = async (id: string) => {
    setError(null)
    try {
      await vulns.unaccept(id)
      onChanged()
    } catch (err) {
      setError(err as Error)
    }
  }
  return (
    <div className="overflow-x-auto">
      {error && (
        <div className="p-3">
          <ErrorBox error={error} />
        </div>
      )}
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-zinc-200 text-left text-xs text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
            <th className="py-2.5 pr-3 pl-4 font-medium">Severity</th>
            <th className="px-3 py-2.5 font-medium">Vulnerability</th>
            <th className="px-3 py-2.5 font-medium">Minions</th>
            <th className="px-3 py-2.5 font-medium">Why</th>
            <th className="px-3 py-2.5 font-medium">Accepted</th>
            <th className="px-3 py-2.5 pr-4" />
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800/70">
          {list.map((a) => (
            <tr key={a.id} className="align-top">
              <td className="py-2.5 pr-3 pl-4">{a.vuln ? <SeverityBadge severity={a.vuln.severity} score={a.vuln.score} /> : <Badge>gone</Badge>}</td>
              <td className="px-3 py-2.5">
                {a.vuln ? <VulnLink v={a.vuln} /> : <span className="font-mono text-xs">{a.id}</span>}
                {a.packages.length > 0 && <div className="font-mono text-xs text-zinc-500 dark:text-zinc-400">{a.packages.join(', ')}</div>}
              </td>
              <td className="px-3 py-2.5">
                <Badge>{a.minions}</Badge>
              </td>
              <td className="max-w-md px-3 py-2.5 text-xs text-zinc-700 dark:text-zinc-300">{a.note}</td>
              <td className="px-3 py-2.5 text-xs whitespace-nowrap text-zinc-500 dark:text-zinc-400">
                {a.acceptedBy ?? 'someone'}, {relTime(new Date(a.acceptedAt))}
                <div>
                  {a.expiresAt ? `until ${new Date(a.expiresAt).toLocaleDateString()}` : 'until withdrawn'}
                  {a.expiresAt && expiresSoon(a.expiresAt) && (
                    <Badge tone="amber" className="ml-1.5" title="When it expires, the vulnerability counts again; accept it again to extend it">
                      {daysLeft(a.expiresAt) <= 1 ? 'expires today' : `expires in ${daysLeft(a.expiresAt)} days`}
                    </Badge>
                  )}
                </div>
              </td>
              <td className="px-3 py-2.5 pr-4 text-right">
                {canAccept && (
                  <Button size="sm" icon={<Undo2 className="size-3.5" />} onClick={() => void withdraw(a.id)}>
                    Withdraw
                  </Button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function MinionTable({ list }: { list: VulnMinion[] }) {
  const [open, setOpen] = useState<string | null>(null)
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-zinc-200 text-left text-xs text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
            <th className="w-0 py-2.5 pr-1 pl-4" />
            <th className="px-3 py-2.5 font-medium">Minion</th>
            <th className="px-3 py-2.5 font-medium">OS</th>
            <th className="px-3 py-2.5 font-medium">Vulnerabilities</th>
            <th className="hidden px-3 py-2.5 font-medium sm:table-cell">With a fix</th>
            <th className="hidden px-3 py-2.5 pr-4 font-medium md:table-cell">Inventory</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800/70">
          {list.map((m) => (
            <MinionRow key={m.minion} m={m} open={open === m.minion} onToggle={() => setOpen(open === m.minion ? null : m.minion)} />
          ))}
        </tbody>
      </table>
    </div>
  )
}

function MinionRow({ m, open, onToggle }: { m: VulnMinion; open: boolean; onToggle: () => void }) {
  return (
    <>
      <tr onClick={m.error ? undefined : onToggle} className={clsx('align-top', !m.error && 'cursor-pointer hover:bg-zinc-50 dark:hover:bg-zinc-800/30')}>
        <td className="py-2.5 pr-1 pl-4">
          {!m.error && (
            <button aria-expanded={open} aria-label={`${open ? 'Hide' : 'Show'} vulnerabilities on ${m.minion}`} className="rounded text-zinc-400 focus-visible:outline-2 focus-visible:outline-accent-500">
              <ChevronRight className={clsx('size-4 transition', open && 'rotate-90')} />
            </button>
          )}
        </td>
        <td className="px-3 py-2.5 font-mono font-medium">{m.minion}</td>
        <td className="px-3 py-2.5 text-zinc-600 dark:text-zinc-400">{m.os ?? '—'}</td>
        <td className="px-3 py-2.5">{m.error ? <span className="text-xs text-zinc-500 dark:text-zinc-400">{m.error}</span> : <CountsBadges counts={m.counts} />}</td>
        <td className="hidden px-3 py-2.5 text-zinc-600 tabular-nums sm:table-cell dark:text-zinc-400">{m.error ? '' : m.counts.fixable}</td>
        <td className="hidden px-3 py-2.5 pr-4 text-xs text-zinc-500 md:table-cell dark:text-zinc-400">
          <Link
            to={`/jobs/${m.jid}`}
            onClick={(e) => e.stopPropagation()}
            className={clsx('hover:text-accent-600', isStale(m.scannedAt) && 'font-medium text-amber-700 dark:text-amber-400')}
            title={`${new Date(m.scannedAt).toLocaleString()}${isStale(m.scannedAt) ? ' — more than a week old; scan again for current results' : ''}`}
          >
            {relTime(new Date(m.scannedAt))}
          </Link>
          {!m.error && ` · ${m.packages} packages`}
        </td>
      </tr>
      {open && (
        <tr>
          <td colSpan={6} className="bg-zinc-50/60 px-4 py-3 dark:bg-zinc-900/40">
            <Findings minion={m.minion} />
          </td>
        </tr>
      )}
    </>
  )
}

/** The Vulnerabilities tab of a minion's page. */
export function MinionVulnerabilities({ id }: { id: string }) {
  const vulns = useVulnApi()
  const { data, error } = useAsync(() => vulns.minion(id).catch((e: Error) => (/no inventory/i.test(e.message) ? null : Promise.reject(e))), [vulns, id])
  if (error) return <div className="p-4"><ErrorBox error={error} /></div>
  if (data === undefined) return <Spinner />
  if (data === null)
    return (
      <Empty icon={<ShieldCheck />} title="Not scanned yet">
        Scan it on the{' '}
        <Link to="/vulnerabilities" className="text-accent-700 hover:underline dark:text-accent-400">
          Vulnerabilities
        </Link>{' '}
        page to check its packages.
      </Empty>
    )
  const m = data.minion
  return (
    <div className="space-y-3 p-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
        {m.error ? <span className="text-zinc-500 dark:text-zinc-400">{m.error}</span> : <CountsBadges counts={m.counts} />}
        <span className="text-xs text-zinc-500 dark:text-zinc-400">
          {m.os && `${m.os} · `}
          <Link to={`/jobs/${m.jid}`} className={clsx('hover:text-accent-600', isStale(m.scannedAt) && 'font-medium text-amber-700 dark:text-amber-400')}>
            inventory {relTime(new Date(m.scannedAt))}
          </Link>
          {!m.error && ` · ${m.packages} packages`}
        </span>
        <Link to={`/vulnerabilities?view=minions&q=${encodeURIComponent(id)}`} className="ml-auto text-xs text-accent-700 hover:underline dark:text-accent-400">
          All minions →
        </Link>
      </div>
      {!m.error && <FindingsTable findings={data.findings} />}
    </div>
  )
}

function Findings({ minion }: { minion: string }) {
  const vulns = useVulnApi()
  const { data, error } = useAsync(() => vulns.minion(minion), [vulns, minion])
  if (error) return <ErrorBox error={error} />
  if (!data) return <Spinner />
  return <FindingsTable findings={data.findings} />
}

function FindingsTable({ findings }: { findings: VulnFinding[] }) {
  if (!findings.length) return <p className="text-sm text-zinc-500 dark:text-zinc-400">No known vulnerabilities.</p>
  return (
    <table className="w-full text-xs">
      <thead>
        <tr className="text-left text-zinc-500 dark:text-zinc-400">
          <th className="py-1 pr-3 font-medium">Severity</th>
          <th className="py-1 pr-3 font-medium">Vulnerability</th>
          <th className="py-1 pr-3 font-medium">Installed</th>
          <th className="py-1 font-medium">Fixed in</th>
        </tr>
      </thead>
      <tbody>
        {findings.map((f) => (
          <tr key={`${f.id}|${f.package}`} className="align-top">
            <td className="py-1 pr-3">
              <SeverityBadge severity={f.severity} score={f.score} />
            </td>
            <td className="py-1 pr-3">
              <VulnLink v={f} />
            </td>
            <td className="py-1 pr-3 font-mono text-zinc-600 dark:text-zinc-400">
              {f.package} {f.version}
            </td>
            <td className="py-1 font-mono text-zinc-600 dark:text-zinc-400">{f.fixed ?? <span className="font-sans text-zinc-500">no fix yet</span>}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
