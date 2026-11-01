import clsx from 'clsx'
import { CheckCircle2, ChevronRight, CircleDashed, Clock, FileCode2, Loader2, Play, Workflow, XCircle } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { SaltError, type FileTree } from '../api/types'
import { CodeView } from '../components/CodeView'
import { JsonView } from '../components/JsonView'
import { ResultView } from '../components/ResultView'
import { stateSummary } from '../lib/states'
import { Badge, Button, Card, CardHeader, Empty, ErrorBox, PageHeader, PermNote, Spinner } from '../components/ui'
import { useAsync, useStoredState } from '../lib/hooks'
import { useCan, useSalt, useSession } from '../lib/session'
import { relTime } from './Jobs'

interface Step {
  __id__?: string
  __run_num__?: number
  name?: string
  result: boolean | null
  comment?: string
  duration?: number
  changes?: { out?: string; ret?: Record<string, unknown> } & Record<string, unknown>
}

interface OrchRun {
  jid: string | null
  sls: string
  test: boolean
  started: number
  ret?: unknown
  done: boolean
}

interface RecentRun {
  jid: string
  sls: string
  test: boolean
  at: number
}

const ORCH_DIRS = /^(orch|orchestrate|orchestration)\//

function flatten(tree: FileTree, prefix = ''): string[] {
  return Object.entries(tree).flatMap(([name, node]) => (typeof node === 'string' ? [prefix + name] : flatten(node, `${prefix}${name}/`)))
}

/** orch/deploy.sls -> orch.deploy, orch/web/init.sls -> orch.web */
const toSls = (path: string) => path.replace(/\/init\.sls$|\.sls$/, '').replace(/\//g, '.')

/** Pulls the step dict out of state.orchestrate's {data: {<master>_master: {...}}} return. */
function stepsOf(ret: unknown): Array<[string, Step]> | null {
  const data = (ret as { data?: Record<string, unknown> } | undefined)?.data
  const inner = data && Object.values(data)[0]
  if (!inner || typeof inner !== 'object' || Array.isArray(inner)) return null
  return (Object.entries(inner) as Array<[string, Step]>).sort((a, b) => (a[1].__run_num__ ?? 0) - (b[1].__run_num__ ?? 0))
}

export function OrchestratePage() {
  const salt = useSalt()
  const { subscribe, session } = useSession()
  const can = useCan()
  const canRun = can('runner', 'state.orchestrate')
  const roots = useAsync(() => salt.roots('file'), [salt])
  const [showAll, setShowAll] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  const [test, setTest] = useState(true)
  const [pillar, setPillar] = useState('')
  const [run, setRun] = useState<OrchRun | null>(null)
  const [error, setError] = useState<Error | null>(null)
  const [recent, setRecent] = useStoredState<RecentRun[]>(`salt-shaker.orch.recent.${session?.mode}.${session?.apiUrl}`, [])
  const stop = useRef<() => void>(() => undefined)
  useEffect(() => () => stop.current(), [])

  const files = useMemo(() => {
    const all = Object.values(roots.data ?? {})
      .flat()
      .flatMap((root) => Object.values(root).flatMap((t) => flatten(t)))
      .filter((p) => p.endsWith('.sls') && p !== 'top.sls')
    return [...new Set(all)].sort()
  }, [roots.data])
  const orchFiles = files.filter((f) => ORCH_DIRS.test(f))
  const shown = showAll || orchFiles.length === 0 ? files : orchFiles

  useEffect(() => {
    if (!selected && shown[0]) setSelected(shown[0])
  }, [shown, selected])

  const source = useAsync(() => (selected ? salt.readFile('file', selected) : Promise.resolve('')), [salt, selected])

  let pillarError: string | null = null
  let pillarValue: Record<string, unknown> | undefined
  if (pillar.trim()) {
    try {
      const v = JSON.parse(pillar)
      if (!v || typeof v !== 'object' || Array.isArray(v)) pillarError = 'Pillar must be a JSON object'
      else pillarValue = v
    } catch {
      pillarError = 'Invalid JSON'
    }
  }

  const watch = useCallback(
    (jid: string) => {
      stop.current()
      const finish = (ret: unknown) => setRun((r) => (r && r.jid === jid ? { ...r, ret, done: true } : r))
      const unsubscribe = subscribe((e) => {
        if (e.tag === `salt/run/${jid}/ret`) finish(e.data.return)
      })
      let timer: ReturnType<typeof setTimeout>
      const poll = async () => {
        try {
          const res = await salt.runnerResult(jid)
          if (res) return finish(res.return)
        } catch {
          // events may still deliver it
        }
        timer = setTimeout(poll, 4000)
      }
      timer = setTimeout(poll, 2000)
      stop.current = () => {
        clearTimeout(timer)
        unsubscribe()
      }
    },
    [salt, subscribe],
  )

  useEffect(() => {
    if (run?.done) stop.current()
  }, [run?.done])

  const start = async () => {
    if (!selected || pillarError) return
    const sls = toSls(selected)
    const kwarg: Record<string, unknown> = { ...(test ? { test: true } : {}), ...(pillarValue ? { pillar: pillarValue } : {}) }
    setError(null)
    try {
      const jid = await salt.runnerAsync('state.orchestrate', [sls], kwarg)
      setRun({ jid, sls, test, started: Date.now(), done: false })
      setRecent((r) => [{ jid, sls, test, at: Date.now() }, ...r].slice(0, 8))
      watch(jid)
    } catch (e) {
      // masters without runner_async enabled: run synchronously instead
      if (e instanceof SaltError && /runner_async/.test(e.message)) {
        setRun({ jid: null, sls, test, started: Date.now(), done: false })
        try {
          const ret = await salt.runner('state.orchestrate', { arg: [sls], kwarg })
          setRun((r) => (r && r.jid === null ? { ...r, ret, done: true } : r))
        } catch (e2) {
          setError(e2 as Error)
          setRun(null)
        }
      } else setError(e as Error)
    }
  }

  const openRecent = async (r: RecentRun) => {
    setRun({ jid: r.jid, sls: r.sls, test: r.test, started: r.at, done: false })
    watch(r.jid)
  }

  return (
    <>
      <PageHeader title="Orchestrate" description="Run orchestration SLS files (state.orchestrate) that coordinate states across many minions in order." />

      <div className="grid gap-6 lg:grid-cols-[260px_1fr]">
        <div className="space-y-6">
          <Card className="h-fit">
            <CardHeader
              title="Orchestrations"
              subtitle={orchFiles.length ? 'From orch/ in file_roots' : 'No orch/ directory — showing all SLS'}
              actions={
                orchFiles.length > 0 && (
                  <label className="flex items-center gap-1.5 text-xs text-zinc-500">
                    <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} className="accent-accent-600" />
                    all
                  </label>
                )
              }
            />
            <div className="max-h-[45vh] overflow-y-auto p-2">
              {roots.error && <ErrorBox error={roots.error} onRetry={roots.reload} />}
              {roots.loading && <Spinner />}
              {shown.map((f) => (
                <button
                  key={f}
                  onClick={() => setSelected(f)}
                  className={clsx(
                    'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm',
                    selected === f ? 'bg-accent-50 font-medium text-accent-700 dark:bg-accent-700/20 dark:text-accent-400' : 'text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800/60',
                  )}
                >
                  <FileCode2 className="size-3.5 shrink-0 text-accent-500" />
                  <span className="truncate font-mono text-xs">{toSls(f)}</span>
                </button>
              ))}
            </div>
          </Card>

          {recent.length > 0 && (
            <Card>
              <CardHeader title="Recent runs" />
              <ul className="divide-y divide-zinc-100 dark:divide-zinc-800/70">
                {recent.map((r) => (
                  <li key={r.jid}>
                    <button onClick={() => openRecent(r)} className="w-full px-4 py-2 text-left hover:bg-zinc-50 dark:hover:bg-zinc-800/40">
                      <p className="truncate font-mono text-xs font-medium">
                        {r.sls} {r.test && <span className="text-amber-600">test</span>}
                      </p>
                      <p className="text-[11px] text-zinc-500">{relTime(new Date(r.at))}</p>
                    </button>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>

        <div className="min-w-0 space-y-6">
          {!selected ? (
            <Card>
              <Empty icon={<Workflow />} title="No orchestration selected">
                Put orchestration SLS files under <code className="font-mono">orch/</code> in your file_roots.
              </Empty>
            </Card>
          ) : (
            <Card>
              <CardHeader title={<span className="font-mono">{toSls(selected)}</span>} subtitle={`salt://${selected}`} />
              <div className="max-h-72 overflow-y-auto border-b border-zinc-100 py-2 dark:border-zinc-800">
                {source.loading ? <Spinner /> : source.error ? <div className="p-3"><ErrorBox error={source.error} /></div> : <CodeView code={source.data ?? ''} />}
              </div>
              <div className="space-y-3 p-4">
                <details className="text-sm">
                  <summary className="cursor-pointer text-xs font-medium text-zinc-600 dark:text-zinc-400">Pillar overrides (JSON, optional)</summary>
                  <textarea
                    value={pillar}
                    onChange={(e) => setPillar(e.target.value)}
                    placeholder='{"version": "1.4.2"}'
                    rows={3}
                    className="mt-2 w-full rounded-lg border border-zinc-200 bg-white p-2 font-mono text-xs focus:border-accent-500 focus:outline-none dark:border-zinc-800 dark:bg-zinc-900"
                  />
                  {pillarError && <p className="text-xs text-red-600">{pillarError}</p>}
                </details>
                <div className="flex flex-wrap items-center gap-4">
                  <label className="flex items-center gap-2 text-sm">
                    <input type="checkbox" checked={test} onChange={(e) => setTest(e.target.checked)} className="accent-accent-600" />
                    Dry run (<code className="font-mono text-xs">test=True</code>)
                  </label>
                  <Button
                    className="ml-auto"
                    variant={test ? 'primary' : 'success'}
                    icon={<Play className="size-4" />}
                    onClick={start}
                    loading={!!run && !run.done}
                    disabled={!canRun || !!pillarError}
                  >
                    {test ? 'Dry-run orchestration' : 'Run orchestration'}
                  </Button>
                </div>
                {!canRun && <PermNote>Your account cannot run state.orchestrate (needs @runner).</PermNote>}
              </div>
            </Card>
          )}

          {error && <ErrorBox error={error} />}
          {run && <OrchResult run={run} />}
        </div>
      </div>
    </>
  )
}

function OrchResult({ run }: { run: OrchRun }) {
  const [elapsed, setElapsed] = useState(0)
  useEffect(() => {
    if (run.done) return
    const t = setInterval(() => setElapsed(Math.round((Date.now() - run.started) / 1000)), 1000)
    return () => clearInterval(t)
  }, [run.done, run.started])

  const steps = run.done ? stepsOf(run.ret) : null
  const sum = steps ? stateSummary(Object.fromEntries(steps)) : null
  return (
    <Card>
      <CardHeader
        title={
          <span className="flex flex-wrap items-center gap-2">
            <span className="font-mono">{run.sls}</span>
            {run.test && <Badge tone="amber">test</Badge>}
            {!run.done && (
              <Badge tone="blue">
                <Loader2 className="size-3 animate-spin" /> running {elapsed}s
              </Badge>
            )}
            {sum && sum.failed === 0 && <Badge tone="green">succeeded</Badge>}
            {sum && sum.failed > 0 && <Badge tone="red">{sum.failed} step{sum.failed > 1 && 's'} failed</Badge>}
          </span>
        }
        subtitle={run.jid && <span className="font-mono">jid {run.jid}</span>}
        actions={
          run.jid && (
            <Link to={`/jobs/${run.jid}`} className="text-xs font-medium text-accent-600 hover:underline dark:text-accent-400">
              Open job
            </Link>
          )
        }
      />
      <div className="p-3">
        {!run.done && <Spinner label="The master is running the orchestration…" />}
        {run.done && !steps && (typeof run.ret === 'string' || Array.isArray(run.ret) ? <pre className="font-mono text-xs whitespace-pre-wrap text-red-600">{([] as unknown[]).concat(run.ret).join('\n')}</pre> : <JsonView value={run.ret} />)}
        {steps && (
          <ol className="space-y-2">
            {steps.map(([key, step], i) => (
              <StepRow key={key} index={i + 1} fn={key.split('_|-').pop() ?? ''} step={step} />
            ))}
          </ol>
        )}
      </div>
    </Card>
  )
}

function StepRow({ index, fn, step }: { index: number; fn: string; step: Step }) {
  const ret = step.changes?.ret
  const hasDetail = !!ret && Object.keys(ret).length > 0
  const [open, setOpen] = useState(step.result === false && hasDetail)
  const Icon = step.result === false ? XCircle : step.result === null ? CircleDashed : CheckCircle2
  return (
    <li className="overflow-hidden rounded-lg border border-zinc-200 dark:border-zinc-800">
      <button onClick={() => hasDetail && setOpen(!open)} className="flex w-full items-start gap-3 px-3 py-2.5 text-left hover:bg-zinc-50 dark:hover:bg-zinc-800/30">
        <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-zinc-100 text-[11px] font-semibold text-zinc-500 dark:bg-zinc-800">{index}</span>
        <Icon className={clsx('mt-0.5 size-4 shrink-0', step.result === false ? 'text-red-500' : step.result === null ? 'text-amber-500' : 'text-emerald-500')} />
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-2 text-sm">
            <span className="font-medium">{step.__id__}</span>
            <span className="font-mono text-xs text-zinc-500">salt.{fn}</span>
            {hasDetail && <span className="text-xs text-zinc-400">· {Object.keys(ret!).length === 1 ? '1 minion' : `${Object.keys(ret!).length} minions`}</span>}
          </p>
          {step.comment && <p className="mt-0.5 text-xs whitespace-pre-wrap text-zinc-600 dark:text-zinc-400">{step.comment}</p>}
        </div>
        {step.duration !== undefined && (
          <span className="flex shrink-0 items-center gap-1 text-xs text-zinc-400 tabular-nums">
            <Clock className="size-3" />
            {(step.duration / 1000).toFixed(1)}s
          </span>
        )}
        <ChevronRight className={clsx('mt-0.5 size-4 shrink-0 text-zinc-400 transition-transform', open && 'rotate-90', !hasDetail && 'invisible')} />
      </button>
      {open && ret && (
        <div className="border-t border-zinc-200 bg-zinc-50/50 p-3 dark:border-zinc-800 dark:bg-zinc-950/30">
          <ResultView results={ret} />
        </div>
      )}
    </li>
  )
}
