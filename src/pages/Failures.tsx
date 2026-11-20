import clsx from 'clsx'
import { CheckCircle2, ChevronRight, FlaskConical, OctagonX, Play, RefreshCw, Search, Server } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { demoFailures } from '../api/demo-failures'
import { history } from '../api/server'
import { Badge, Button, Card, CopyButton, Empty, ErrorBox, Input, PageHeader, PermNote, Spinner, Stat, Tabs } from '../components/ui'
import { rerunArgs, type FailureGroup } from '../lib/failures'
import { relTime } from '../lib/format'
import { useAsync } from '../lib/hooks'
import { useCan, useSession } from '../lib/session'

const RANGES = [
  { value: '24', label: 'Last day' },
  { value: '72', label: '3 days' },
  { value: '168', label: '7 days' },
] as const
type Range = (typeof RANGES)[number]['value']

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

/** What's failing in the recent state runs across the fleet, one line per state and error. */
export function FailuresPage() {
  const { session } = useSession()
  const can = useCan()
  const canRun = can('local', 'state.apply')
  const [params, setParams] = useSearchParams()
  const range: Range = RANGES.find((r) => r.value === params.get('hours'))?.value ?? '24'
  const [q, setQ] = useState('')
  const demo = session?.mode === 'demo'
  const { data, error, loading, reload } = useAsync(() => (demo ? demoFailures(Number(range)) : history.failures(Number(range))), [demo, range])

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase()
    if (!data || !needle) return data?.groups ?? []
    return data.groups.filter((g) => [g.label, g.message, g.sls ?? '', ...g.minions.map((m) => m.id)].some((s) => s.toLowerCase().includes(needle)))
  }, [data, q])
  const minions = new Set(data?.groups.flatMap((g) => g.minions.map((m) => m.id)) ?? [])

  return (
    <>
      <PageHeader
        title="Failures"
        description="What fails in the recent state runs across the fleet, one line per state and error. A failure drops off once a later run on that minion gets the state through."
        actions={
          <Button icon={<RefreshCw className="size-4" />} onClick={reload} loading={loading && !!data}>
            Refresh
          </Button>
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Tabs value={range} onChange={(v) => setParams(v === '24' ? {} : { hours: v }, { replace: true })} items={RANGES.map((r) => ({ value: r.value, label: r.label }))} />
        <div className="relative min-w-56 flex-1 sm:max-w-sm">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-zinc-400" />
          <Input aria-label="Filter failures" placeholder="Filter by minion, state or error" value={q} onChange={(e) => setQ(e.target.value)} className="pl-8" />
        </div>
      </div>

      {error && <ErrorBox error={error} onRetry={reload} />}
      {!data && !error && <Spinner label="Reading the state runs…" />}

      {data && (
        <>
          <div className="mb-6 grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Stat label="Failures" value={data.groups.length} icon={<OctagonX />} tone={data.groups.length ? 'red' : 'green'} hint="distinct state and error" />
            <Stat label="Minions affected" value={minions.size} icon={<Server />} tone={minions.size ? 'red' : 'green'} />
            <Stat label="State runs read" value={data.runs} icon={<Play />} hint={data.capped ? 'the most recent ones; pick a shorter range for all' : `since ${new Date(data.since).toLocaleString()}`} />
          </div>
          {!canRun && data.groups.length > 0 && <PermNote className="mb-3">Your account cannot run state.apply, so it can see failures but not run them again.</PermNote>}

          <Card>
            {data.groups.length === 0 ? (
              <Empty icon={<CheckCircle2 />} title="Nothing failing">
                No state failed in the state runs of the {RANGES.find((r) => r.value === range)!.label.toLowerCase()}, or a later run got it through.
              </Empty>
            ) : shown.length === 0 ? (
              <Empty icon={<Search />} title="No failure matches the filter" />
            ) : (
              <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
                {shown.map((g) => (
                  <FailureRow key={g.key} group={g} canRun={canRun} />
                ))}
              </ul>
            )}
          </Card>
        </>
      )}
    </>
  )
}

function FailureRow({ group: g, canRun }: { group: FailureGroup; canRun: boolean }) {
  const [open, setOpen] = useState(false)
  const navigate = useNavigate()
  const ids = g.minions.map((m) => m.id)
  const run = (dryRun: boolean) => navigate(`/run?tgt=${encodeURIComponent(ids.join(','))}&tgt_type=list&fun=state.apply&args=${encodeURIComponent(rerunArgs(g, dryRun))}`)
  const what = g.sls ? `state.apply ${g.sls}` : 'the highstate'

  return (
    <li aria-label={`${g.label}: ${g.message}`}>
      <div className="flex flex-wrap items-start gap-3 px-4 py-3">
        <button onClick={() => setOpen(!open)} aria-expanded={open} className="flex min-w-0 flex-1 items-start gap-2 text-left">
          <ChevronRight className={clsx('mt-0.5 size-4 shrink-0 text-zinc-400 transition-transform', open && 'rotate-90')} />
          <span className="min-w-0">
            <span className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-sm font-medium">{g.label}</span>
              {g.kind === 'run' && <Badge tone="amber">didn’t get to its states</Badge>}
              {g.kind === 'state' && g.sls && <span className="text-xs text-zinc-500 dark:text-zinc-400">in {g.sls}</span>}
            </span>
            <span className="mt-1 block text-sm break-words text-red-700 dark:text-red-400">{g.message}</span>
            <span className="mt-1 block text-xs text-zinc-500 dark:text-zinc-400">
              on {plural(ids.length, 'minion')}
              {ids.length <= 3 ? `: ${ids.join(', ')}` : `: ${ids.slice(0, 3).join(', ')} and ${ids.length - 3} more`} · last {relTime(new Date(g.lastSeen))}
            </span>
          </span>
        </button>
        {canRun && (
          <div className="flex shrink-0 gap-2">
            <Button size="sm" icon={<FlaskConical className="size-3.5" />} onClick={() => run(true)}>
              Dry run
            </Button>
            <Button size="sm" variant="primary" icon={<Play className="size-3.5" />} onClick={() => run(false)}>
              Run again on {ids.length}
            </Button>
          </div>
        )}
      </div>
      {open && (
        <div className="border-t border-zinc-100 bg-zinc-50/60 px-4 py-2 dark:border-zinc-800 dark:bg-zinc-950/30">
          <div className="mb-1 flex items-center justify-between">
            <span className="text-xs text-zinc-500 dark:text-zinc-400">{canRun ? <>Run again applies {what} to these minions; Dry run shows what it would change.</> : 'Minions'}</span>
            <CopyButton text={ids.join(',')} label="Copy list" />
          </div>
          <ul aria-label="Minions" className="space-y-2 pb-1">
            {g.minions.map((m) => (
              <li key={m.id} className="text-sm">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <Link to={`/minions/${encodeURIComponent(m.id)}`} className="font-mono font-medium hover:text-accent-600">
                    {m.id}
                  </Link>
                  <Link to={`/jobs/${m.jid}`} className="font-mono text-xs text-zinc-500 hover:text-accent-600 dark:text-zinc-400">
                    {m.fun} · jid {m.jid}
                  </Link>
                  {m.dryRun && <Badge tone="blue">dry run</Badge>}
                  <span className="text-xs text-zinc-500 dark:text-zinc-400">{relTime(new Date(m.at))}</span>
                </div>
                {m.comment.trim() && m.comment.trim() !== g.message && <pre className="mt-1 max-h-40 overflow-auto rounded-md bg-white p-2 text-xs whitespace-pre-wrap text-zinc-700 ring-1 ring-zinc-200 dark:bg-zinc-900 dark:text-zinc-300 dark:ring-zinc-800">{m.comment.trim()}</pre>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </li>
  )
}
