import { ArrowLeft, Cpu, HardDrive, History, Network, Play, Search, Terminal } from 'lucide-react'
import { useState } from 'react'
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { formatArgs } from '../api/salt'
import { history, minionOutcome, parseStoredArgs, type MinionJob } from '../api/server'
import type { Grains } from '../api/types'
import { JsonView } from '../components/JsonView'
import { Badge, Button, Card, CardHeader, Empty, ErrorBox, Input, Spinner, StatusDot, Tabs, type Tone } from '../components/ui'
import { useAsync } from '../lib/hooks'
import { useSalt, useSession } from '../lib/session'
import { OsIcon } from './Minions'
import { fmtMem, funTone, relTime } from '../lib/format'

const TABS = ['grains', 'pillar', 'jobs'] as const

export function MinionDetailPage() {
  const { id = '' } = useParams()
  const salt = useSalt()
  const navigate = useNavigate()
  const { session } = useSession()
  const location = useLocation()
  // the tab and the filter live in the address, so going back from a job returns to the Jobs tab
  const [params, setParams] = useSearchParams()
  const tab = TABS.find((t) => t === params.get('tab') && (t !== 'jobs' || session?.mode === 'server')) ?? 'grains'
  const filter = params.get('q') ?? ''
  const update = (k: 'tab' | 'q', value: string) =>
  {
    // from the address bar, not the last render: typing right after switching tabs must keep the tab
    const next = new URLSearchParams(window.location.search)
    if (value && !(k === 'tab' && value === 'grains')) next.set(k, value)
    else next.delete(k)
    setParams(next, { replace: true, state: location.state })
  }
  // the Minions list with the filters it had when this minion was opened
  const back = (location.state as { back?: string } | null)?.back

  const grains = useAsync(async () => {
    const [g, status] = await Promise.all([salt.grains(id, 'list'), salt.status()])
    return { grains: g[id] as Grains | undefined, up: status.up.includes(id) }
  }, [salt, id])
  const pillar = useAsync(() => (tab === 'pillar' ? salt.pillar(id) : Promise.resolve(undefined)), [salt, id, tab])

  const g = grains.data?.grains
  const filtered = (obj: Record<string, unknown> | undefined) =>
    obj && filter ? Object.fromEntries(Object.entries(obj).filter(([k, v]) => k.includes(filter) || JSON.stringify(v).includes(filter))) : obj

  const run = (fun: string, args = '') => navigate(`/run?tgt=${encodeURIComponent(id)}&tgt_type=list&fun=${encodeURIComponent(fun)}&args=${encodeURIComponent(args)}`)

  return (
    <>
      <Link to={back ? `/?${back}` : '/'} className="mb-4 inline-flex items-center gap-1 text-sm text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200 dark:text-zinc-400">
        <ArrowLeft className="size-4" /> Minions
      </Link>

      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-center gap-3">
          <StatusDot up={grains.data?.up} />
          <div>
            <h1 className="font-mono text-xl font-semibold tracking-tight">{id}</h1>
            <p className="text-sm text-zinc-500 dark:text-zinc-400">{g?.fqdn as string | undefined}</p>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button icon={<Play className="size-4" />} onClick={() => run('test.ping')}>
            Ping
          </Button>
          <Button icon={<Play className="size-4" />} onClick={() => run('state.apply', 'test=True')}>
            Dry-run highstate
          </Button>
          <Button variant="primary" icon={<Terminal className="size-4" />} onClick={() => run('cmd.run', "'uptime'")}>
            Run command
          </Button>
        </div>
      </div>

      {grains.error && <ErrorBox error={grains.error} onRetry={grains.reload} />}
      {grains.loading && !grains.data && <Spinner />}
      {grains.data && !g && (
        <Card className="mb-6 p-4 text-sm text-zinc-500 dark:text-zinc-400">This minion did not return grains — it is probably offline. Its key is still accepted.</Card>
      )}

      {g && (
        <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Fact icon={<OsIcon os={g.os} />} label="Operating system" value={`${g.os} ${g.osrelease}`} sub={`${g.kernel} ${g.kernelrelease}`} />
          <Fact icon={<Cpu className="size-4 text-zinc-500 dark:text-zinc-400" />} label="Hardware" value={`${g.num_cpus} vCPU · ${fmtMem(g.mem_total)}`} sub={`${g.cpu_model ?? ''}`} />
          <Fact icon={<Network className="size-4 text-zinc-500 dark:text-zinc-400" />} label="Addresses" value={g.ipv4?.filter((ip) => ip !== '127.0.0.1').join(', ') || '—'} sub={`virtual: ${g.virtual ?? '—'}`} />
          <Fact
            icon={<HardDrive className="size-4 text-zinc-500 dark:text-zinc-400" />}
            label="Salt"
            value={g.saltversion ?? '—'}
            sub={
              <span className="flex flex-wrap gap-1">
                {(Array.isArray(g.roles) ? g.roles : []).map((r) => (
                  <Badge key={r}>{r}</Badge>
                ))}
              </span>
            }
          />
        </div>
      )}

      <Card>
        <CardHeader
          title={
            <Tabs
              value={tab}
              onChange={(t) => update('tab', t)}
              items={[
                { value: 'grains', label: 'Grains' },
                { value: 'pillar', label: 'Pillar' },
                // job history is recorded by the server
                ...(session?.mode === 'server' ? [{ value: 'jobs' as const, label: 'Jobs' }] : []),
              ]}
            />
          }
          actions={
            tab !== 'jobs' && (
            <div className="relative">
              <Search className="pointer-events-none absolute top-2.5 left-3 size-4 text-zinc-500 dark:text-zinc-400" />
              <Input value={filter} onChange={(e) => update('q', e.target.value)} placeholder="Filter keys…" className="w-56 pl-9" />
            </div>
            )
          }
        />
        {tab === 'jobs' && <MinionJobs id={id} />}
        <div className={tab === 'jobs' ? 'hidden' : 'p-4 pl-8'}>
          {tab === 'grains' && g && <JsonView value={filtered(g)} openDepth={1} />}
          {tab === 'pillar' && (
            <>
              {pillar.error && <ErrorBox error={pillar.error} onRetry={pillar.reload} />}
              {pillar.loading && <Spinner label="Compiling pillar…" />}
              {pillar.data && !pillar.loading && <JsonView value={filtered(pillar.data)} openDepth={3} />}
            </>
          )}
        </div>
      </Card>
    </>
  )
}

const OUTCOME: Record<ReturnType<typeof minionOutcome>, { tone: Tone; label: string }> = {
  ok: { tone: 'green', label: 'ok' },
  changed: { tone: 'blue', label: 'changed' },
  drift: { tone: 'amber', label: 'drift' },
  failed: { tone: 'red', label: 'failed' },
  noreturn: { tone: 'zinc', label: 'no return' },
}

const JOBS_PAGE = 50

/** Recorded jobs that ran on this minion, each with how it ended here. */
function MinionJobs({ id }: { id: string }) {
  const navigate = useNavigate()
  const [older, setOlder] = useState<MinionJob[]>([])
  const [loadingMore, setLoadingMore] = useState(false)
  const first = useAsync(() => history.minionJobs(id, { limit: JOBS_PAGE }), [id])
  const rows = [...(first.data?.rows ?? []), ...older]
  const more = (first.data?.rows.length ?? 0) === JOBS_PAGE && older.length % JOBS_PAGE === 0

  const loadMore = async () => {
    const last = rows[rows.length - 1]
    if (!last) return
    setLoadingMore(true)
    try {
      const res = await history.minionJobs(id, { before: Date.parse(last.startedAt), limit: JOBS_PAGE })
      setOlder((o) => [...o, ...res.rows])
    } finally {
      setLoadingMore(false)
    }
  }

  if (first.error) return <div className="p-4"><ErrorBox error={first.error} onRetry={first.reload} /></div>
  if (!first.data) return <Spinner />
  if (rows.length === 0)
    return (
      <Empty icon={<History />} title="No jobs recorded for this minion">
        Jobs that target it show up here for {first.data.retentionDays} days.
      </Empty>
    )
  return (
    <>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-zinc-200 text-left text-xs text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
              <th className="py-2.5 pr-3 pl-4 font-medium">Function</th>
              <th className="hidden px-3 py-2.5 font-medium md:table-cell">By</th>
              <th className="px-3 py-2.5 font-medium">Result here</th>
              <th className="px-3 py-2.5 pr-4 font-medium">Started</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800/70">
            {rows.map((j) => {
              const o = OUTCOME[minionOutcome(j)]
              const at = new Date(j.startedAt)
              return (
                <tr key={j.jid} onClick={() => navigate(`/jobs/${j.jid}`)} className="cursor-pointer hover:bg-zinc-50 dark:hover:bg-zinc-800/30">
                  <td className="py-2.5 pr-3 pl-4">
                    <div className="flex items-center gap-2">
                      <Link to={`/jobs/${j.jid}`} onClick={(e) => e.stopPropagation()} className="rounded-md focus-visible:outline-2 focus-visible:outline-accent-500">
                        <Badge tone={funTone(j.fun)} className="font-mono">
                          {j.fun}
                        </Badge>
                      </Link>
                      {j.dryRun && <Badge tone="amber">dry run</Badge>}
                      <span className="max-w-64 truncate font-mono text-xs text-zinc-500 dark:text-zinc-400">{formatArgs(parseStoredArgs(j.args)).replace(/\s*test=True/, '')}</span>
                    </div>
                  </td>
                  <td className="hidden px-3 py-2.5 md:table-cell">
                    {j.shakerUser ? <span className="font-medium">{j.shakerUser}</span> : <span className="text-zinc-500 dark:text-zinc-400">{j.saltUser ?? '—'} <span className="text-xs">(salt)</span></span>}
                  </td>
                  <td className="px-3 py-2.5">
                    <Badge tone={o.tone}>{o.label}</Badge>
                  </td>
                  <td className="px-3 py-2.5 pr-4 whitespace-nowrap text-zinc-600 dark:text-zinc-400" title={at.toLocaleString()}>
                    {relTime(at)}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      {more && (
        <div className="border-t border-zinc-100 p-3 text-center dark:border-zinc-800">
          <Button size="sm" loading={loadingMore} onClick={loadMore}>
            Load older
          </Button>
        </div>
      )}
    </>
  )
}

function Fact({ icon, label, value, sub }: { icon: React.ReactNode; label: string; value: string; sub?: React.ReactNode }) {
  return (
    <Card className="p-4">
      <div className="flex items-center gap-2 text-xs font-medium text-zinc-500 dark:text-zinc-400">
        {icon}
        {label}
      </div>
      <p className="mt-2 truncate font-medium" title={value}>
        {value}
      </p>
      {sub && <div className="mt-0.5 truncate text-xs text-zinc-500 dark:text-zinc-400">{sub}</div>}
    </Card>
  )
}
