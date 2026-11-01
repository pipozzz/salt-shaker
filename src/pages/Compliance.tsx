import clsx from 'clsx'
import { AlertOctagon, CheckCircle2, ChevronRight, CircleDashed, ExternalLink, Play, ShieldCheck, Unplug, Wrench } from 'lucide-react'
import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import type { TargetType } from '../api/types'
import { JsonView } from '../components/JsonView'
import { stateSummary, StateList } from '../components/ResultView'
import { TargetField } from '../components/TargetField'
import { Badge, Button, Card, CardHeader, Empty, ErrorBox, PageHeader, Stat } from '../components/ui'
import { useStoredState } from '../lib/hooks'
import { useSession } from '../lib/session'
import { useJob } from '../lib/useJob'
import { relTime } from './Jobs'

type Status = 'error' | 'drift' | 'noreturn' | 'ok' | 'waiting'

interface Row {
  id: string
  status: Status
  ret?: unknown
  wouldChange: number
  failed: number
}

const ORDER: Record<Status, number> = { error: 0, drift: 1, noreturn: 2, waiting: 3, ok: 4 }

function classify(id: string, results: Record<string, unknown>, done: boolean): Row {
  if (!(id in results)) return { id, status: done ? 'noreturn' : 'waiting', wouldChange: 0, failed: 0 }
  const ret = results[id]
  const sum = stateSummary(ret)
  // a non-state return from state.apply means the run never started (render error, no top match…)
  if (!sum) return { id, status: 'error', ret, wouldChange: 0, failed: 0 }
  const wouldChange = sum.pending + sum.changed
  return { id, status: sum.failed ? 'error' : wouldChange ? 'drift' : 'ok', ret, wouldChange, failed: sum.failed }
}

export function CompliancePage() {
  const { session } = useSession()
  const navigate = useNavigate()
  const { run, start, load } = useJob()
  const scope = `salt-shaker.compliance.${session?.mode}.${session?.apiUrl}`
  const [last, setLast] = useStoredState<{ jid: string; tgt: string; tgtType: TargetType } | null>(scope, null)
  const [tgt, setTgt] = useState(last?.tgt ?? '*')
  const [tgtType, setTgtType] = useState<TargetType>(last?.tgtType ?? 'glob')
  const [error, setError] = useState<Error | null>(null)
  const [starting, setStarting] = useState(false)
  const [filter, setFilter] = useState<Status | 'all'>('all')

  // show the previous check when coming back to the page
  useEffect(() => {
    if (last && !run) load(last.jid).catch(() => setLast(null))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const check = async (e?: FormEvent) => {
    e?.preventDefault()
    setError(null)
    setStarting(true)
    try {
      const jid = await start(tgt, tgtType, 'state.apply', [], { test: true })
      setLast({ jid, tgt, tgtType })
    } catch (err) {
      setError(err as Error)
    } finally {
      setStarting(false)
    }
  }

  const rows = useMemo(() => {
    if (!run) return []
    const ids = [...new Set([...run.minions, ...Object.keys(run.results)])]
    return ids.map((id) => classify(id, run.results, run.done)).sort((a, b) => ORDER[a.status] - ORDER[b.status] || b.wouldChange - a.wouldChange || a.id.localeCompare(b.id))
  }, [run])

  const count = (s: Status) => rows.filter((r) => r.status === s).length
  const drifted = rows.filter((r) => r.status === 'drift').map((r) => r.id)
  const returned = run ? Object.keys(run.results).length : 0
  const shown = filter === 'all' ? rows : rows.filter((r) => r.status === filter)
  const isEmptyJob = run && run.done && run.minions.length === 0 && returned === 0

  const fix = (ids: string[]) => navigate(`/run?tgt=${encodeURIComponent(ids.join(','))}&tgt_type=list&fun=state.apply&args=`)

  return (
    <>
      <PageHeader title="Compliance" description="Dry-run the highstate across your fleet to find minions that drifted from their desired state." />

      <Card className="mb-6">
        <form onSubmit={check} className="flex flex-wrap items-start gap-3 p-4">
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
          <Button type="submit" variant="primary" className="sm:mt-[22px]" icon={<Play className="size-4" />} loading={starting || (run !== null && !run.done)}>
            {run && !run.done ? `Checking… ${returned}/${run.minions.length}` : 'Check now'}
          </Button>
        </form>
        {run && (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-zinc-100 px-4 py-2 text-xs text-zinc-500 dark:border-zinc-800">
            <span>
              {run.done ? 'Checked' : 'Started'} {relTime(new Date(run.started))}
            </span>
            <Link to={`/jobs/${run.jid}`} className="inline-flex items-center gap-1 font-mono hover:text-accent-600">
              jid {run.jid} <ExternalLink className="size-3" />
            </Link>
            <span className="text-zinc-400">state.apply test=True — nothing is changed on minions</span>
          </div>
        )}
        {run && !run.done && (
          <div className="h-1 overflow-hidden bg-zinc-100 dark:bg-zinc-800">
            <div className="h-full bg-accent-500 transition-all duration-500" style={{ width: `${run.minions.length ? (returned / run.minions.length) * 100 : 0}%` }} />
          </div>
        )}
      </Card>

      {error && (
        <div className="mb-6">
          <ErrorBox error={error} />
        </div>
      )}

      {!run && (
        <Card>
          <Empty icon={<ShieldCheck />} title="No compliance check yet">
            Run a check to compare every minion against its highstate. It uses <code className="font-mono">test=True</code>, so it is safe to run anytime.
          </Empty>
        </Card>
      )}

      {isEmptyJob && (
        <Card>
          <Empty icon={<ShieldCheck />} title="The previous check is no longer in the job cache">
            Run a new check.
          </Empty>
        </Card>
      )}

      {run && !isEmptyJob && (
        <>
          <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
            <FilterStat active={filter === 'ok'} onClick={() => setFilter(filter === 'ok' ? 'all' : 'ok')}>
              <Stat label="In compliance" value={count('ok')} icon={<CheckCircle2 />} tone="green" />
            </FilterStat>
            <FilterStat active={filter === 'drift'} onClick={() => setFilter(filter === 'drift' ? 'all' : 'drift')}>
              <Stat label="Drifted" value={count('drift')} icon={<CircleDashed />} tone={count('drift') ? 'amber' : 'zinc'} hint={count('drift') ? `${rows.reduce((n, r) => n + r.wouldChange, 0)} states would change` : undefined} />
            </FilterStat>
            <FilterStat active={filter === 'error'} onClick={() => setFilter(filter === 'error' ? 'all' : 'error')}>
              <Stat label="Errors" value={count('error')} icon={<AlertOctagon />} tone={count('error') ? 'red' : 'zinc'} />
            </FilterStat>
            <FilterStat active={filter === 'noreturn'} onClick={() => setFilter(filter === 'noreturn' ? 'all' : 'noreturn')}>
              <Stat label={run.done ? 'No return' : 'Waiting'} value={run.done ? count('noreturn') : count('waiting')} icon={<Unplug />} tone="zinc" />
            </FilterStat>
          </div>

          <Card>
            <CardHeader
              title={filter === 'all' ? 'All minions' : `Filtered: ${filter}`}
              subtitle="Sorted by severity. Expand a minion to see what would change."
              actions={
                drifted.length > 0 &&
                run.done && (
                  <Button size="sm" variant="primary" icon={<Wrench className="size-3.5" />} onClick={() => fix(drifted)}>
                    Remediate {drifted.length} drifted
                  </Button>
                )
              }
            />
            {shown.length === 0 ? (
              <Empty title="Nothing here" />
            ) : (
              <ul className="divide-y divide-zinc-100 dark:divide-zinc-800/70">
                {shown.map((r) => (
                  <MinionRow key={r.id} row={r} onFix={() => fix([r.id])} />
                ))}
              </ul>
            )}
          </Card>
        </>
      )}
    </>
  )
}

function FilterStat({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button onClick={onClick} className={clsx('rounded-xl text-left transition', active ? 'ring-2 ring-accent-500' : 'hover:ring-2 hover:ring-zinc-300 dark:hover:ring-zinc-700')}>
      {children}
    </button>
  )
}

const STATUS_UI: Record<Status, { icon: ReactNode; label: string }> = {
  ok: { icon: <CheckCircle2 className="size-4 text-emerald-500" />, label: 'In compliance' },
  drift: { icon: <CircleDashed className="size-4 text-amber-500" />, label: 'Drifted' },
  error: { icon: <AlertOctagon className="size-4 text-red-500" />, label: 'Error' },
  noreturn: { icon: <Unplug className="size-4 text-zinc-400" />, label: 'No return' },
  waiting: { icon: <CircleDashed className="size-4 animate-spin text-zinc-400" />, label: 'Waiting…' },
}

function MinionRow({ row, onFix }: { row: Row; onFix: () => void }) {
  const [open, setOpen] = useState(false)
  const expandable = row.status === 'drift' || row.status === 'error'
  const isStates = !!stateSummary(row.ret)
  return (
    <li>
      <div className="flex items-center gap-3 px-4 py-2.5">
        <button onClick={() => expandable && setOpen(!open)} className={clsx('flex min-w-0 flex-1 items-center gap-3 text-left', !expandable && 'cursor-default')}>
          <ChevronRight className={clsx('size-4 shrink-0 text-zinc-400 transition-transform', open && 'rotate-90', !expandable && 'invisible')} />
          {STATUS_UI[row.status].icon}
          <span className="font-mono text-sm font-medium">{row.id}</span>
          <span className="flex flex-wrap gap-1.5">
            {row.wouldChange > 0 && <Badge tone="amber">{row.wouldChange} would change</Badge>}
            {row.failed > 0 && <Badge tone="red">{row.failed} failed</Badge>}
            {row.status === 'error' && !isStates && <Badge tone="red">did not run</Badge>}
            {(row.status === 'ok' || row.status === 'noreturn' || row.status === 'waiting') && <span className="text-xs text-zinc-500">{STATUS_UI[row.status].label}</span>}
          </span>
        </button>
        {row.status === 'drift' && (
          <Button size="sm" variant="ghost" icon={<Wrench className="size-3.5" />} onClick={onFix}>
            Remediate
          </Button>
        )}
      </div>
      {open && (
        <div className="border-t border-zinc-100 bg-zinc-50/50 px-4 py-3 pl-11 dark:border-zinc-800 dark:bg-zinc-950/30">
          {isStates ? <StateList ret={row.ret} interesting /> : typeof row.ret === 'string' ? <pre className="font-mono text-xs whitespace-pre-wrap">{row.ret}</pre> : <JsonView value={row.ret} />}
        </div>
      )}
    </li>
  )
}
