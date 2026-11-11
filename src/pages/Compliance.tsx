import clsx from 'clsx'
import { AlertOctagon, CheckCircle2, ChevronRight, CircleDashed, ExternalLink, GitCompare, Play, ShieldCheck, Unplug, Wrench } from 'lucide-react'
import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { history, type ComplianceRun } from '../api/server'
import type { TargetType } from '../api/types'
import { JsonView } from '../components/JsonView'
import { StateList } from '../components/ResultView'
import { stateSummary } from '../lib/states'
import { classify, ORDER, type Row, type Status } from '../lib/compliance'
import { TargetField } from '../components/TargetField'
import { Badge, Button, Card, CardHeader, Empty, ErrorBox, PageHeader, PermNote, ShowMore, Stat } from '../components/ui'
import { useAsync, usePaged, useStoredState } from '../lib/hooks'
import { useCan, useSession } from '../lib/session'
import { useJob } from '../lib/useJob'
import { relTime } from '../lib/format'

export function CompliancePage() {
  const { session } = useSession()
  const can = useCan()
  const canCheck = can('local', 'state.apply')
  const canFix = canCheck
  const navigate = useNavigate()
  const { run, start, load, setRun } = useJob()
  const fromServer = session?.mode === 'server'
  const past = useAsync(() => (fromServer ? history.compliance(20) : Promise.resolve(null)), [fromServer, run?.done])

  /** Opens a past check: from the server's history when available (it outlives the master's cache). */
  const openRun = async (jid: string) => {
    if (fromServer) {
      try {
        const { job, returns } = await history.job(jid)
        setRun({
          jid,
          fun: job.fun,
          minions: JSON.parse(job.minions ?? '[]') as string[],
          results: Object.fromEntries(returns.map((r) => [r.minion, r.ret])),
          gaveUp: [],
          done: true,
          timedOut: false,
          started: Date.parse(job.startedAt),
        })
        if (job.target) {
          setTgt(job.target)
          setTgtType((job.targetType as TargetType) ?? 'glob')
        }
        return
      } catch {
        // not recorded (e.g. older than the server); try the master
      }
    }
    await load(jid)
  }
  const scope = `salt-shaker.compliance.${session?.mode}.${session?.apiUrl}`
  const [last, setLast] = useStoredState<{ jid: string; tgt: string; tgtType: TargetType } | null>(scope, null)
  const [tgt, setTgt] = useState(last?.tgt ?? '*')
  const [tgtType, setTgtType] = useState<TargetType>(last?.tgtType ?? 'glob')
  const [error, setError] = useState<Error | null>(null)
  const [starting, setStarting] = useState(false)
  const [filter, setFilter] = useState<Status | 'all'>('all')

  // show the previous check when coming back to the page
  useEffect(() => {
    if (last && !run) openRun(last.jid).catch(() => setLast(null))
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
  const paged = usePaged(shown, `${run?.jid}|${filter}`)
  const isEmptyJob = run && run.done && run.minions.length === 0 && returned === 0

  const fix = (ids: string[]) => navigate(`/run?tgt=${encodeURIComponent(ids.join(','))}&tgt_type=list&fun=state.apply&args=`)

  return (
    <>
      <PageHeader
        title="Compliance"
        description="Dry-run the highstate across your fleet to find minions that drifted from their desired state."
        actions={
          <div className="flex flex-wrap gap-2">
            <Link to="/compliance/hardening" className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm font-medium shadow-xs hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:hover:bg-zinc-800">
              <ShieldCheck className="size-4" /> Hardening checks
            </Link>
            <Link to="/compliance/preview" className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm font-medium shadow-xs hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:hover:bg-zinc-800">
              <GitCompare className="size-4" /> Preview a branch
            </Link>
          </div>
        }
      />

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
          <Button type="submit" variant="primary" className="sm:mt-[22px]" icon={<Play className="size-4" />} loading={starting || (run !== null && !run.done)} disabled={!canCheck}>
            {run && !run.done ? `Checking… ${returned}/${run.minions.length}` : 'Check now'}
          </Button>
        </form>
        {!canCheck && <PermNote className="px-4 pb-3">Your account cannot run state.apply, so it can only view earlier checks.</PermNote>}
        {run && (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-zinc-100 px-4 py-2 text-xs text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
            <span>
              {run.done ? 'Checked' : 'Started'} {relTime(new Date(run.started))}
            </span>
            <Link to={`/jobs/${run.jid}`} className="inline-flex items-center gap-1 font-mono hover:text-accent-600">
              jid {run.jid} <ExternalLink className="size-3" />
            </Link>
            <span className="text-zinc-500 dark:text-zinc-400">state.apply test=True — nothing is changed on minions</span>
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

      {fromServer && past.data && past.data.runs.length > 0 && <History runs={past.data.runs} current={run?.jid} onOpen={(jid) => void openRun(jid).catch((e) => setError(e as Error))} />}

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
                canFix &&
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
              <>
                <ul className="divide-y divide-zinc-100 dark:divide-zinc-800/70">
                  {paged.visible.map((r) => (
                    <MinionRow key={r.id} row={r} onFix={canFix ? () => fix([r.id]) : undefined} />
                  ))}
                </ul>
                <ShowMore paged={paged} />
              </>
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
  noreturn: { icon: <Unplug className="size-4 text-zinc-500 dark:text-zinc-400" />, label: 'No return' },
  waiting: { icon: <CircleDashed className="size-4 animate-spin text-zinc-500 dark:text-zinc-400" />, label: 'Waiting…' },
}

function MinionRow({ row, onFix }: { row: Row; onFix?: () => void }) {
  const [open, setOpen] = useState(false)
  const expandable = row.status === 'drift' || row.status === 'error'
  const isStates = !!stateSummary(row.ret)
  return (
    <li>
      <div className="flex items-center gap-3 px-4 py-2.5">
        <button onClick={() => expandable && setOpen(!open)} className={clsx('flex min-w-0 flex-1 items-center gap-3 text-left', !expandable && 'cursor-default')}>
          <ChevronRight className={clsx('size-4 shrink-0 text-zinc-500 transition-transform dark:text-zinc-400', open && 'rotate-90', !expandable && 'invisible')} />
          {STATUS_UI[row.status].icon}
          <span className="font-mono text-sm font-medium">{row.id}</span>
          <span className="flex flex-wrap gap-1.5">
            {row.wouldChange > 0 && <Badge tone="amber">{row.wouldChange} would change</Badge>}
            {row.failed > 0 && <Badge tone="red">{row.failed} failed</Badge>}
            {row.status === 'error' && !isStates && <Badge tone="red">did not run</Badge>}
            {(row.status === 'ok' || row.status === 'noreturn' || row.status === 'waiting') && <span className="text-xs text-zinc-500 dark:text-zinc-400">{STATUS_UI[row.status].label}</span>}
          </span>
        </button>
        {row.status === 'drift' && onFix && (
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

const SEGMENTS: Array<{ key: keyof ComplianceRun['counts']; label: string; className: string }> = [
  { key: 'ok', label: 'In compliance', className: 'bg-emerald-500' },
  { key: 'drift', label: 'Drifted', className: 'bg-amber-500' },
  { key: 'error', label: 'Errors', className: 'bg-red-500' },
  { key: 'noreturn', label: 'No return', className: 'bg-zinc-300 dark:bg-zinc-600' },
]

/** Past checks as one stacked status bar each, newest first. */
function History({ runs, current, onOpen }: { runs: ComplianceRun[]; current?: string; onOpen: (jid: string) => void }) {
  return (
    <Card className="mb-6">
      <CardHeader
        title="History"
        subtitle="Earlier checks, kept by the server. Open one to see its details."
        actions={
          <div className="hidden flex-wrap items-center gap-3 text-xs text-zinc-500 sm:flex dark:text-zinc-400">
            {SEGMENTS.map((s) => (
              <span key={s.key} className="flex items-center gap-1.5">
                <span className={clsx('size-2.5 rounded-sm', s.className)} />
                {s.label}
              </span>
            ))}
          </div>
        }
      />
      <ul className="max-h-72 divide-y divide-zinc-100 overflow-y-auto dark:divide-zinc-800/70">
        {runs.map((r) => {
          const total = SEGMENTS.reduce((n, s) => n + r.counts[s.key], 0)
          const at = new Date(r.startedAt)
          return (
            <li key={r.jid}>
              <button
                onClick={() => onOpen(r.jid)}
                className={clsx('grid w-full grid-cols-[7rem_1fr] items-center gap-x-4 gap-y-1 px-4 py-2 text-left text-sm hover:bg-zinc-50 sm:grid-cols-[7rem_10rem_1fr_9rem] dark:hover:bg-zinc-800/30', current === r.jid && 'bg-accent-50/60 dark:bg-accent-700/10')}
              >
                <span className="text-xs text-zinc-500 dark:text-zinc-400" title={at.toLocaleString()}>
                  {relTime(at)}
                </span>
                <span className="hidden truncate font-mono text-xs sm:block">
                  {r.targetType && r.targetType !== 'glob' ? `${r.targetType}:` : ''}
                  {r.target ?? '*'}
                  {r.by && <span className="font-sans text-zinc-500 dark:text-zinc-400"> · {r.by}</span>}
                </span>
                <span className="flex h-2.5 gap-0.5 overflow-hidden rounded-full" aria-hidden>
                  {SEGMENTS.filter((s) => r.counts[s.key] > 0).map((s) => (
                    <span key={s.key} className={clsx('h-full first:rounded-l-full last:rounded-r-full', s.className)} style={{ flexGrow: r.counts[s.key] }} />
                  ))}
                  {total === 0 && <span className="h-full flex-1 rounded-full bg-zinc-100 dark:bg-zinc-800" />}
                </span>
                <span className="col-span-2 text-xs text-zinc-600 tabular-nums sm:col-span-1 sm:text-right dark:text-zinc-400">
                  {r.counts.ok} ok · {r.counts.drift} drifted{r.counts.error > 0 && ` · ${r.counts.error} errors`}
                </span>
              </button>
            </li>
          )
        })}
      </ul>
    </Card>
  )
}
