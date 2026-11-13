import clsx from 'clsx'
import { ArrowLeft, Check, ChevronRight, CircleDashed, CircleX, Hand, Loader2, Minus, Play, RotateCcw, SkipForward, Square } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import type { RunbookStepState } from '../api/server'
import { ResultView } from '../components/ResultView'
import { Badge, Button, Card, CardHeader, ErrorBox, PageHeader, Spinner } from '../components/ui'
import { formatArgs } from '../api/salt'
import { relTime } from '../lib/format'
import { useAsync } from '../lib/hooks'
import { jobResults, loadJobDetail } from '../lib/job-detail'
import { continueFrom } from '../lib/runbook'
import { RUN_STATUS, useRunbookRole, useRunbooksApi } from '../lib/runbooks'
import { useSalt, useSession } from '../lib/session'
import { RunModal } from './Runbooks'

const STEP_ICON: Record<RunbookStepState['status'], { icon: typeof Check; cls: string; label: string }> = {
  waiting: { icon: CircleDashed, cls: 'text-zinc-400', label: 'waiting' },
  paused: { icon: Hand, cls: 'text-amber-600 dark:text-amber-400', label: 'waiting to go on' },
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
  const { canWrite, canRun: anyRun, me, mayRun } = useRunbookRole()
  const navigate = useNavigate()
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
  // the runbook, to run it again with this run's values; gone if it was deleted
  const runbook = useAsync(() => (api && anyRun ? api.list() : Promise.resolve(null)), [api, anyRun]).data?.runbooks.find((rb) => rb.id === run?.runbookId) ?? null
  // one it names someone else for, I don't run again or continue
  const canRun = runbook ? mayRun(runbook) : anyRun
  const [again, setAgain] = useState(false)
  const from = run ? continueFrom(run) : null
  const resume = async () => {
    setBusy('continue')
    setError(null)
    try {
      const { run: next } = await api!.continue(Number(id))
      navigate(`/runbooks/runs/${next.id}`)
    } catch (e) {
      setError(e as Error)
    } finally {
      setBusy(null)
    }
  }
  const paused = run?.status === 'running' && run.steps[run.cursor]?.status === 'paused' ? run.steps[run.cursor] : null
  const mayGoOn = canWrite || run?.startedBy === me
  const proceed = async () => {
    setBusy('proceed')
    setError(null)
    try {
      await api!.proceed(Number(id))
      setTick((n) => n + 1)
    } catch (e) {
      setError(e as Error)
    } finally {
      setBusy(null)
    }
  }
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
                {canRun && from !== null && (
                  <Button size="sm" variant="primary" icon={<SkipForward className="size-3.5" />} loading={busy === 'continue'} onClick={resume} title={`A new run from step ${from + 1}, ${run.steps[from].name}; the steps before stay as they ran here`}>
                    Continue from step {from + 1}
                  </Button>
                )}
                {canRun && !live && runbook && (
                  <Button size="sm" icon={<RotateCcw className="size-3.5" />} onClick={() => setAgain(true)}>
                    Run again
                  </Button>
                )}
              </div>
            }
          />
          {error && <ErrorBox error={error} />}
          {again && runbook && <RunModal runbook={runbook} initial={run.params} onClose={() => setAgain(false)} />}
          {paused && (
            <div className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
              <span>
                Step {run.cursor + 1}, {paused.name}, waits for {mayGoOn ? 'you' : `${run.startedBy} or an admin`} to go on. Look at the output of the steps before it first; nothing runs until then.
              </span>
              {mayGoOn && (
                <Button size="sm" variant="primary" icon={<Play className="size-3.5" />} loading={busy === 'proceed'} onClick={proceed}>
                  Go on with step {run.cursor + 1}
                </Button>
              )}
            </div>
          )}
          {run.status === 'pending' && <p className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">It changes minions, so an admin other than {run.startedBy} approves it first. Nothing runs until then.</p>}
          {run.error && (
            <p className="mb-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200">
              {run.error}
              {run.status === 'running' && '. Running the steps for a failure.'}
            </p>
          )}

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
                        {s.onFailure && <span className="text-xs text-amber-700 dark:text-amber-400">· if it fails</span>}
                        {s.confirm && <span className="text-xs text-zinc-500 dark:text-zinc-400">· {s.confirmedBy ? `let go on by ${s.confirmedBy}` : 'asks first'}</span>}
                        {s.fromRun && (
                          <span className="text-xs text-zinc-500 dark:text-zinc-400">
                            · in{' '}
                            <Link to={`/runbooks/runs/${s.fromRun}`} className="text-accent-700 hover:underline dark:text-accent-400">
                              run #{s.fromRun}
                            </Link>
                          </span>
                        )}
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
  // a step that fails while the page is open opens too
  const [failed, setFailed] = useState(startOpen)
  if (failed !== startOpen) {
    setFailed(startOpen)
    if (startOpen) setOpen(true)
  }
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
