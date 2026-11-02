import clsx from 'clsx'
import { CircleOff, KeyRound, RefreshCw, Search, Server, TriangleAlert, Wifi, X } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { compareVersions } from '../api/salt'
import { history } from '../api/server'
import type { Grains } from '../api/types'
import { Badge, Button, Card, Empty, ErrorBox, Input, PageHeader, Spinner, Stat, StatusDot, Tabs, type Tone } from '../components/ui'
import { useAsync } from '../lib/hooks'
import { useSalt, useSession } from '../lib/session'
import { fmtMem, relTime } from '../lib/format'

export function OsIcon({ os }: { os?: string }) {
  const color: Record<string, string> = { Ubuntu: 'bg-orange-500', Debian: 'bg-rose-600', Rocky: 'bg-emerald-700', CentOS: 'bg-violet-600', RedHat: 'bg-red-600', Windows: 'bg-sky-600', MacOS: 'bg-zinc-600' }
  return <span className={clsx('inline-flex size-5 items-center justify-center rounded text-[10px] font-bold text-white', color[os ?? ''] ?? 'bg-zinc-400')}>{os?.[0] ?? '?'}</span>
}

const PAGE = 100

const COMPLIANCE: Record<'ok' | 'drift' | 'error', { tone: Tone; label: string }> = {
  ok: { tone: 'green', label: 'in compliance' },
  drift: { tone: 'amber', label: 'drifted' },
  error: { tone: 'red', label: 'error' },
}

export function MinionsPage() {
  const salt = useSalt()
  const navigate = useNavigate()
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<'all' | 'up' | 'down'>('all')
  const [facet, setFacet] = useState<Facet | null>(null)

  // grains come from the master's cache and render right away; who answers (manage.status pings
  // every minion and waits for the slow ones) fills in when it's ready
  const [refreshes, setRefreshes] = useState(0)
  const { data, error, loading } = useAsync(async () => {
    const [grains, keys, masterVersion] = await Promise.all([salt.fleet(refreshes > 0), salt.keys(), salt.masterVersion()])
    return { grains, keys, masterVersion }
  }, [salt, refreshes])
  const status = useAsync(() => salt.status(), [salt, refreshes])
  // the latest compliance result per minion is recorded by the server
  const { session } = useSession()
  const fromServer = session?.mode === 'server'
  const compliance = useAsync(() => (fromServer ? history.minionCompliance() : Promise.resolve(null)), [fromServer, refreshes])
  const reload = () => setRefreshes((n) => n + 1)

  const rows = useMemo(() => {
    if (!data) return []
    const up = status.data ? new Set(status.data.up) : null
    return data.keys.minions
      .map((id) => ({ id, up: up ? up.has(id) : undefined, g: (data.grains[id] ?? {}) as Grains }))
      .filter((r) => (filter === 'all' || r.up === undefined ? true : filter === 'up' ? r.up : !r.up))
      .filter((r) => !facet || facetValues(facet.kind, r.g).includes(facet.value))
      .filter((r) => {
        if (!query) return true
        const hay = [r.id, r.g.os, r.g.osrelease, ...(r.g.ipv4 ?? []), ...(r.g.roles ?? [])].join(' ').toLowerCase()
        return query.toLowerCase().split(/\s+/).every((q) => hay.includes(q))
      })
      .sort((a, b) => Number(b.up ?? 0) - Number(a.up ?? 0) || a.id.localeCompare(b.id))
  }, [data, status.data, query, filter, facet])

  // render in pages; any change of filters starts again from the first page
  const filterKey = `${query}|${filter}|${facet?.kind}:${facet?.value}`
  const [paging, setPaging] = useState({ key: '', count: PAGE })
  const visibleCount = paging.key === filterKey ? paging.count : PAGE
  const visible = rows.slice(0, visibleCount)

  return (
    <>
      <PageHeader
        title="Minions"
        description="Accepted minions, their status and key facts from grains."
        actions={
          <Button icon={<RefreshCw className={clsx('size-4', loading && 'animate-spin')} />} onClick={reload} disabled={loading}>
            Refresh
          </Button>
        }
      />

      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Accepted" value={data?.keys.minions.length ?? '—'} icon={<Server />} tone="accent" />
        <Stat label="Responding" value={status.data?.up.length ?? '—'} icon={<Wifi />} tone="green" hint={status.loading && !status.data ? 'Pinging minions…' : undefined} />
        <Stat label="Not responding" value={status.data?.down.length ?? '—'} icon={<CircleOff />} tone={status.data?.down.length ? 'red' : 'zinc'} />
        <Link to="/keys" className="rounded-xl transition hover:ring-2 hover:ring-amber-500/30">
          <Stat
            label="Pending keys"
            value={data?.keys.minions_pre.length ?? '—'}
            icon={<KeyRound />}
            tone={data?.keys.minions_pre.length ? 'amber' : 'zinc'}
            hint={data?.keys.minions_pre.length ? 'Waiting for approval →' : undefined}
          />
        </Link>
      </div>

      {data && <Fleet grains={data.grains} masterVersion={data.masterVersion} active={facet} onPick={(f) => setFacet(f && facet?.kind === f.kind && facet.value === f.value ? null : f)} />}

      <Card>
        <div className="flex flex-wrap items-center gap-3 border-b border-zinc-200 p-3 dark:border-zinc-800">
          {facet && (
            <button
              onClick={() => setFacet(null)}
              className="inline-flex items-center gap-1 rounded-full bg-accent-50 px-2.5 py-1 text-xs font-medium text-accent-700 dark:bg-accent-700/20 dark:text-accent-400"
            >
              {FACET_LABEL[facet.kind]}: {facet.value}
              <X className="size-3" />
            </button>
          )}
          <div className="relative min-w-48 flex-1">
            <Search className="pointer-events-none absolute top-2.5 left-3 size-4 text-zinc-500 dark:text-zinc-400" />
            <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Filter by id, OS, IP or role…" className="pl-9" />
          </div>
          <Tabs
            value={filter}
            onChange={setFilter}
            items={[
              { value: 'all', label: 'All' },
              { value: 'up', label: 'Up' },
              { value: 'down', label: 'Down' },
            ]}
          />
        </div>

        {error && (
          <div className="p-4">
            <ErrorBox error={error} onRetry={reload} />
          </div>
        )}
        {!data && loading && <Spinner label="Asking minions for grains…" />}
        {data && rows.length === 0 && (
          <Empty icon={<Server />} title={data.keys.minions.length ? 'No minions match' : 'No accepted minions yet'}>
            {data.keys.minions.length ? 'Try a different filter.' : <Link className="text-accent-700 hover:underline" to="/keys">Enroll your first minion →</Link>}
          </Empty>
        )}
        {rows.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-zinc-200 text-left text-xs font-medium text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
                  <th className="py-2.5 pr-3 pl-4 font-medium">Minion</th>
                  <th className="px-3 py-2.5 font-medium">OS</th>
                  {fromServer && <th className="hidden px-3 py-2.5 font-medium sm:table-cell">Compliance</th>}
                  <th className="hidden px-3 py-2.5 font-medium md:table-cell">IP</th>
                  <th className="hidden px-3 py-2.5 font-medium lg:table-cell">CPU / RAM</th>
                  <th className="hidden px-3 py-2.5 font-medium sm:table-cell">Roles</th>
                  <th className="hidden px-3 py-2.5 pr-4 font-medium xl:table-cell">Salt</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800/70">
                {visible.map(({ id, up, g }) => (
                  <tr key={id} onClick={() => navigate(`/minions/${encodeURIComponent(id)}`)} className="cursor-pointer hover:bg-zinc-50 dark:hover:bg-zinc-800/30">
                    <td className="py-2.5 pr-3 pl-4">
                      <div className="flex items-center gap-2.5">
                        <StatusDot up={up} />
                        <span className="font-mono font-medium">{id}</span>
                      </div>
                    </td>
                    <td className="px-3 py-2.5">
                      {g.os ? (
                        <span className="flex items-center gap-2">
                          <OsIcon os={g.os} />
                          {g.os} {g.osrelease}
                        </span>
                      ) : (
                        <span className="text-zinc-500 dark:text-zinc-400">{up ? '—' : 'offline'}</span>
                      )}
                    </td>
                    {fromServer && (
                      <td className="hidden px-3 py-2.5 sm:table-cell">
                        <ComplianceBadge c={compliance.data?.minions[id]} loading={!compliance.data && !compliance.error} />
                      </td>
                    )}
                    <td className="hidden px-3 py-2.5 font-mono text-xs text-zinc-600 md:table-cell dark:text-zinc-400">{g.ipv4?.find((ip) => ip !== '127.0.0.1') ?? '—'}</td>
                    <td className="hidden px-3 py-2.5 text-zinc-600 tabular-nums lg:table-cell dark:text-zinc-400">{g.num_cpus ? `${g.num_cpus} vCPU · ${fmtMem(g.mem_total)}` : '—'}</td>
                    <td className="hidden px-3 py-2.5 sm:table-cell">
                      <div className="flex flex-wrap gap-1">
                        {(Array.isArray(g.roles) ? g.roles : []).map((r) => (
                          <Badge key={r}>{r}</Badge>
                        ))}
                      </div>
                    </td>
                    <td className="hidden px-3 py-2.5 pr-4 font-mono text-xs text-zinc-500 xl:table-cell dark:text-zinc-400">{g.saltversion ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {rows.length > visible.length && (
          <div className="flex items-center justify-center gap-3 border-t border-zinc-100 p-3 text-sm dark:border-zinc-800">
            <span className="text-zinc-500 dark:text-zinc-400">
              Showing {visible.length} of {rows.length}
            </span>
            <Button size="sm" onClick={() => setPaging({ key: filterKey, count: visibleCount + PAGE })}>
              Show {Math.min(PAGE, rows.length - visible.length)} more
            </Button>
          </div>
        )}
        {status.error && <p className="border-t border-zinc-100 px-4 py-2 text-xs text-amber-700 dark:border-zinc-800 dark:text-amber-400">Couldn't check which minions respond: {status.error.message}</p>}
      </Card>
    </>
  )
}

function ComplianceBadge({ c, loading }: { c?: { status: 'ok' | 'drift' | 'error'; jid: string; checkedAt: string }; loading: boolean }) {
  if (!c) return <span className="text-xs text-zinc-500 dark:text-zinc-400">{loading ? '' : 'not checked'}</span>
  const at = new Date(c.checkedAt)
  const { tone, label } = COMPLIANCE[c.status]
  return (
    <Link
      to={`/jobs/${c.jid}`}
      onClick={(e) => e.stopPropagation()}
      title={`Checked ${relTime(at)} (${at.toLocaleString()})`}
      className="rounded-md focus-visible:outline-2 focus-visible:outline-accent-500"
    >
      <Badge tone={tone}>{label}</Badge>
    </Link>
  )
}

type FacetKind = 'os' | 'salt' | 'role'
interface Facet {
  kind: FacetKind
  value: string
}
const FACET_LABEL: Record<FacetKind, string> = { os: 'OS', salt: 'Salt', role: 'Role' }

function facetValues(kind: FacetKind, g: Grains): string[] {
  if (kind === 'os') return g.os ? [`${g.os} ${g.osrelease ?? ''}`.trim()] : []
  if (kind === 'salt') return g.saltversion ? [g.saltversion] : []
  return Array.isArray(g.roles) ? g.roles.map(String) : []
}

function countBy(grains: Record<string, Grains>, kind: FacetKind) {
  const counts = new Map<string, number>()
  for (const g of Object.values(grains)) {
    if (!g || typeof g !== 'object') continue
    for (const v of facetValues(kind, g)) counts.set(v, (counts.get(v) ?? 0) + 1)
  }
  return [...counts.entries()]
}

/** Fleet breakdown by OS, Salt version and role; rows filter the table below. */
function Fleet({ grains, masterVersion, active, onPick }: { grains: Record<string, Grains>; masterVersion: string | null; active: Facet | null; onPick: (f: Facet) => void }) {
  const os = countBy(grains, 'os').sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  const salt = countBy(grains, 'salt').sort((a, b) => compareVersions(b[0], a[0]))
  const roles = countBy(grains, 'role').sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  // without the master's version, compare against the newest minion
  const reference = masterVersion ?? salt[0]?.[0]
  const behind = salt.filter(([v]) => reference && compareVersions(v, reference) < 0).reduce((n, [, c]) => n + c, 0)
  if (os.length + salt.length + roles.length === 0) return null

  return (
    <div className="mb-6 grid gap-3 lg:grid-cols-3">
      <Breakdown title="Operating systems" kind="os" rows={os} active={active} onPick={onPick} />
      <Breakdown
        title="Salt versions"
        subtitle={
          behind ? (
            <span className="flex items-center gap-1 text-amber-700 dark:text-amber-400">
              <TriangleAlert className="size-3.5" /> {behind} {behind === 1 ? 'minion is' : 'minions are'} behind {masterVersion ? `the master (${masterVersion})` : reference}
            </span>
          ) : (
            masterVersion && `All match the master (${masterVersion})`
          )
        }
        kind="salt"
        rows={salt}
        active={active}
        onPick={onPick}
        flag={(v) => (reference && compareVersions(v, reference) < 0 ? 'behind' : null)}
      />
      <Breakdown title="Roles" subtitle={roles.length === 0 ? 'No roles grain set' : undefined} kind="role" rows={roles} active={active} onPick={onPick} />
    </div>
  )
}

function Breakdown({
  title,
  subtitle,
  kind,
  rows,
  active,
  onPick,
  flag,
}: {
  title: string
  subtitle?: React.ReactNode
  kind: FacetKind
  rows: Array<[string, number]>
  active: Facet | null
  onPick: (f: Facet) => void
  flag?: (value: string) => string | null
}) {
  const max = Math.max(1, ...rows.map(([, c]) => c))
  const shown = rows.slice(0, 6)
  return (
    <Card className="p-4">
      <p className="text-xs font-medium text-zinc-500 dark:text-zinc-400">{title}</p>
      {subtitle && <div className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">{subtitle}</div>}
      <ul className="mt-3 space-y-1">
        {shown.map(([value, count]) => {
          const isActive = active?.kind === kind && active.value === value
          const note = flag?.(value)
          return (
            <li key={value}>
              <button
                onClick={() => onPick({ kind, value })}
                aria-pressed={isActive}
                className={clsx('w-full rounded-md px-2 py-1 text-left hover:bg-zinc-100 dark:hover:bg-zinc-800/60', isActive && 'bg-accent-50 ring-1 ring-accent-500/40 dark:bg-accent-700/20')}
              >
                <div className="flex items-center gap-2 text-sm">
                  <span className={clsx('truncate', kind === 'salt' && 'font-mono text-xs')}>{value}</span>
                  {note && (
                    <span className="inline-flex items-center gap-0.5 text-[11px] font-medium text-amber-700 dark:text-amber-400">
                      <TriangleAlert className="size-3" /> {note}
                    </span>
                  )}
                  <span className="ml-auto text-xs text-zinc-600 tabular-nums dark:text-zinc-400">{count}</span>
                </div>
                <div className="mt-1 h-1.5 rounded-full bg-zinc-100 dark:bg-zinc-800">
                  <div className="h-full rounded-full bg-accent-500 dark:bg-accent-400" style={{ width: `${(count / max) * 100}%` }} />
                </div>
              </button>
            </li>
          )
        })}
      </ul>
      {rows.length > shown.length && <p className="mt-2 px-2 text-xs text-zinc-500 dark:text-zinc-400">+{rows.length - shown.length} more</p>}
    </Card>
  )
}
