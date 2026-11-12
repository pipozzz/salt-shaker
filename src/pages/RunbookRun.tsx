import clsx from 'clsx'
import { ArrowLeft, Check, ChevronRight, CircleDashed, CircleX, Loader2, Minus, Square } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import type { RunbookStepState } from '../api/server'
import { ResultView } from '../components/ResultView'
import { Badge, Button, Card, CardHeader, ErrorBox, PageHeader, Spinner } from '../components/ui'
import { formatArgs } from '../api/salt'
import { relTime } from '../lib/format'
import { useAsync } from '../lib/hooks'
import { jobResults, loadJobDetail } from '../lib/job-detail'
import { RUN_STATUS, useRunbookRole, useRunbooksApi } from '../lib/runbooks'
import { useSalt, useSession } from '../lib/session'

const STEP_ICON: Record<RunbookStepState['status'], { icon: typeof Check; cls: string; label: string }> = {
  waiting: { icon: CircleDashed, cls: 'text-zinc-400', label: 'waiting' },
  starting: { icon: Loader2, cls: 'animate-spin text-sky-600 dark:text-sky-400', label: 'starting' },
  running: { icon: Loader2, cls: 'animate-spin text-sky-600 dark:text-sky-400', label: 'running' },
  done: { icon: Check, cls: 'text-emerald-600 dark:text-emerald-400', label: 'done' },
  failed: { icon: CircleX, cls: 'text-red-600 dark:text-red-400', label: 'failed' },
  skipped: { icon: Minus, cls: 'text-zinc-400', label: 'skipped' },
}

const call = (s: RunbookStepState) => `${s.fun} ${formatArgs([...s.arg, ...(Object.keys(s.kwarg).length ? [{ __kwarg__: true, ...s.kwarg }] : [])])}`.trim()

/** One run of a runbook, step by step, refreshed while it runs. */
export function RunbookRunPage() {
  const { id } = useParams()
  const api = useRunbooksApi()
  const { canWrite, me } = useRunbookRole()
  const [tick, setTick] = useState(0)
  const res = useAsync(() => (api ? api.getRun(Number(id)) : Promise.resolve(null)), [api, id, tick])
  const run = res.data?.run
  const live = run?.status === 'running' || run?.status === 'pending'
  useEffect(() => {
    if (!live) return
    const t = setInterval(() => setTick((n) => n + 1), 2000)
    return () => clearInterval(t)
  }, [live])
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<Error | null>(null)
  const act = async (verb: 'stop' | 'approve' | 'reject') => {
    setBusy(verb)
    setError(null)
    try {
      await api!.act(Number(id), verb)
      setTick((n) => n + 1)
    } catch (e) {
      setError(e as Error)
    } finally {
      setBusy(null)
    }
  }

  return (
    <>
      <Link to="/runbooks" className="mb-3 inline-flex items-center gap-1 text-sm text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100">
        <ArrowLeft className="size-3.5" /> Runbooks
      </Link>
      {res.error && !run && <ErrorBox error={res.error} onRetry={res.reload} />}
      {!run && res.loading && <Spinner />}
      {run && (
        <>
          <PageHeader
            title={`${run.name} #${run.id}`}
            description={`Started by ${run.startedBy} ${relTime(new Date(run.startedAt))}${run.decidedBy ? `, ${run.status === 'rejected' ? 'rejected' : 'approved'} by ${run.decidedBy}` : ''}.`}
            actions={
              <div className="flex items-center gap-2">
                <Badge tone={RUN_STATUS[run.status].tone}>{RUN_STATUS[run.status].label}</Badge>
                {run.status === 'pending' && canWrite && run.startedBy !== me && (
                  <>
                    <Button size="sm" variant="primary" loading={busy === 'approve'} onClick={() => act('approve')}>
                      Approve
                    </Button>
                    <Button size="sm" loading={busy === 'reject'} onClick={() => act('reject')}>
                      Reject
                    </Button>
                  </>
                )}
                {live && (canWrite || run.startedBy === me) && (
                  <Button size="sm" variant="danger" icon={<Square className="size-3.5" />} loading={busy === 'stop'} onClick={() => act('stop')}>
                    Stop
                  </Button>
                )}
              </div>
            }
          />
          {error && <ErrorBox error={error} />}
          {run.status === 'pending' && <p className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">It changes minions, so an admin other than {run.startedBy} approves it first. Nothing runs until then.</p>}
          {run.error && <p className="mb-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200">{run.error}</p>}

          <Card className="mb-4">
            <CardHeader title="Values" />
            <dl className="grid grid-cols-[minmax(6rem,auto)_1fr] gap-x-4 gap-y-1 p-4 text-sm">
              {Object.entries(run.params).map(([k, v]) => (
                <div key={k} className="contents">
                  <dt className="font-mono text-xs text-zinc-500 dark:text-zinc-400">{k}</dt>
                  <dd className="font-mono text-xs">{v || '—'}</dd>
                </div>
              ))}
              {!Object.keys(run.params).length && <dd className="col-span-2 text-zinc-500 dark:text-zinc-400">This runbook asks for none.</dd>}
            </dl>
          </Card>

          <Card>
            <CardHeader title="Steps" />
            <ol className="divide-y divide-zinc-100 dark:divide-zinc-800/70" aria-label="Steps">
              {run.steps.map((s, i) => {
                const st = STEP_ICON[s.status]
                const Icon = st.icon
                return (
                  <li key={i} className={clsx('flex gap-3 px-4 py-3', s.status === 'skipped' && 'opacity-60')} aria-label={`${s.name}: ${st.label}`}>
                    <Icon className={clsx('mt-0.5 size-4 shrink-0', st.cls)} aria-hidden />
                    <div className="min-w-0 flex-1 text-sm">
                      <p className="flex flex-wrap items-baseline gap-x-2">
                        <span className="font-medium">
                          {i + 1}. {s.name}
                        </span>
                        <span className="text-xs text-zinc-500 dark:text-zinc-400">{st.label}</span>
                        {s.continueOnFailure && <span className="text-xs text-zinc-500 dark:text-zinc-400">· may fail</span>}
                      </p>
                      <p className="truncate font-mono text-xs text-zinc-600 dark:text-zinc-400">
                        {call(s)} → {s.targetType === 'glob' ? '' : `${s.targetType}:`}
                        {s.target}
                      </p>
                      {(s.status === 'done' || s.status === 'failed' || s.status === 'running') && s.minions && (
                        <p className="mt-1 text-xs text-zinc-600 dark:text-zinc-400">
                          {s.status === 'running' ? `${s.minions.length} ${s.minions.length === 1 ? 'minion' : 'minions'}, waiting for their returns` : `${s.ok ?? 0} ok`}
                          {!!s.failed?.length && <span className="text-red-700 dark:text-red-400"> · failed: {s.failed.join(', ')}</span>}
                          {!!s.missing?.length && <span className="text-amber-700 dark:text-amber-400"> · no return: {s.missing.join(', ')}</span>}
                          {s.jid && (
                            <>
                              {' · '}
                              <Link to={`/jobs/${s.jid}`} className="text-accent-700 hover:underline dark:text-accent-400">
                                job {s.jid}
                              </Link>
                            </>
                          )}
                        </p>
                      )}
                      {s.error && <p className="mt-1 text-xs text-red-700 dark:text-red-400">{s.error}</p>}
                      {s.jid && <StepOutput key={s.jid} name={s.name} jid={s.jid} minions={s.minions ?? []} open={s.status === 'failed'} refresh={s.status === 'running' ? tick : 0} />}
                    </div>
                  </li>
                )
              })}
            </ol>
          </Card>
        </>
      )}
    </>
  )
}

/**
 * What each minion returned for a step, under the step, as on its job's page. Loaded when opened;
 * a failed step starts open, and a running one refreshes with the run.
 */
function StepOutput({ name, jid, minions, open: startOpen, refresh }: { name: string; jid: string; minions: string[]; open: boolean; refresh: number }) {
  const [open, setOpen] = useState(startOpen)
  const salt = useSalt()
  const { session } = useSession()
  const fromServer = session?.mode === 'server'
  const job = useAsync(() => (open ? loadJobDetail(salt, fromServer, jid) : Promise.resolve(null)), [open, salt, fromServer, jid, refresh])
  return (
    <div className="mt-1.5">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-label={`${open ? 'Hide' : 'Show'} the output of ${name}`}
        className="inline-flex items-center gap-0.5 text-xs font-medium text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
      >
        <ChevronRight className={clsx('size-3.5 transition-transform', open && 'rotate-90')} aria-hidden />
        Output
      </button>
      {open && (
        <div className="mt-2">
          {job.error && <ErrorBox error={job.error} onRetry={job.reload} />}
          {!job.data && job.loading && <Spinner />}
          {job.data && <ResultView results={jobResults(job.data)} expected={minions} />}
        </div>
      )}
    </div>
  )
}
