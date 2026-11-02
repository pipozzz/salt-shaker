import clsx from 'clsx'
import { CornerDownLeft, ExternalLink, History, Play, TriangleAlert } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { parseArgs } from '../api/salt'
import type { TargetType } from '../api/types'
import { ResultActions, ResultView } from '../components/ResultView'
import { TargetField } from '../components/TargetField'
import { Badge, Button, Card, CardHeader, ErrorBox, Field, Input, Modal, PageHeader, PermNote } from '../components/ui'
import { confirmLevel } from '../lib/risk'
import { useStoredState } from '../lib/hooks'
import { useCan, useSalt } from '../lib/session'
import { useJob } from '../lib/useJob'

const PRESETS: Array<{ label: string; fun: string; args?: string; danger?: boolean }> = [
  { label: 'Ping', fun: 'test.ping' },
  { label: 'Highstate (dry-run)', fun: 'state.apply', args: 'test=True' },
  { label: 'Highstate', fun: 'state.apply', danger: true },
  { label: 'Uptime', fun: 'cmd.run', args: "'uptime'" },
  { label: 'Disk usage', fun: 'disk.usage' },
  { label: 'Pending upgrades', fun: 'pkg.list_upgrades' },
  { label: 'Sync modules', fun: 'saltutil.sync_all' },
]

interface HistoryItem {
  tgt: string
  tgt_type: TargetType
  fun: string
  args: string
  at: number
}

export function RunPage() {
  const salt = useSalt()
  const [params] = useSearchParams()
  const [tgt, setTgt] = useState(params.get('tgt') ?? '*')
  const [tgtType, setTgtType] = useState<TargetType>((params.get('tgt_type') as TargetType) ?? 'glob')
  const [fun, setFun] = useState(params.get('fun') ?? 'test.ping')
  const [args, setArgs] = useState(params.get('args') ?? '')
  const [history, setHistory] = useStoredState<HistoryItem[]>('salt-shaker.run.history', [])
  const [functions, setFunctions] = useState<string[]>([])
  const { run, start } = useJob()
  const [error, setError] = useState<Error | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [matched, setMatched] = useState<string[] | null>(null)
  // what the current results came from, so "Retry failed" repeats that even if the form changed since
  const [ranWith, setRanWith] = useState<{ fun: string; args: string; tgt: string; tgtType: TargetType } | null>(null)

  const loadFunctions = async () => {
    if (functions.length) return
    try {
      const { up } = await salt.status()
      if (up[0]) setFunctions(await salt.functions(up[0]))
    } catch {
      // autocomplete is best-effort
    }
  }

  const can = useCan()
  const allowed = !fun.trim() || can('local', fun.trim())
  const isWrite = /^state\.(apply|highstate|sls)$/.test(fun) && !/test=(True|true)/.test(args)
  const isCmd = fun.startsWith('cmd.')

  const [confirming, setConfirming] = useState(false)
  const [typed, setTyped] = useState('')
  const level = confirmLevel(fun, args, matched)

  const submit = (e?: FormEvent) => {
    e?.preventDefault()
    if (level !== 'none') {
      setTyped('')
      setConfirming(true)
      return
    }
    void execute()
  }

  const execute = async () => {
    setConfirming(false)
    setError(null)
    setSubmitting(true)
    try {
      const { arg, kwarg } = parseArgs(args)
      await start(tgt, tgtType, fun.trim(), arg, kwarg)
      setRanWith({ fun: fun.trim(), args, tgt, tgtType })
      setHistory((h) => [{ tgt, tgt_type: tgtType, fun, args, at: Date.now() }, ...h.filter((x) => !(x.tgt === tgt && x.fun === fun && x.args === args && x.tgt_type === tgtType))].slice(0, 12))
    } catch (err) {
      setError(err as Error)
    } finally {
      setSubmitting(false)
    }
  }

  const returned = run ? Object.keys(run.results).length : 0

  // fills the form in for another run on just these minions; the user reviews and starts it
  const retry = (minions: string[]) => {
    if (ranWith) {
      setFun(ranWith.fun)
      setArgs(ranWith.args)
    }
    setTgt(minions.join(','))
    setTgtType('list')
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  return (
    <>
      <PageHeader title="Run" description="Execute any execution module on a set of minions. Jobs run asynchronously and show up in Jobs." />

      <div className="grid gap-6 xl:grid-cols-[1fr_280px]">
        <div className="min-w-0 space-y-6">
          <Card>
            <form onSubmit={submit} className="space-y-4 p-4">
              <TargetField
                tgt={tgt}
                tgtType={tgtType}
                onChange={(t, tt) => {
                  setTgt(t)
                  setTgtType(tt)
                }}
                onMatched={setMatched}
              />
              <div className="grid gap-4 sm:grid-cols-[minmax(0,240px)_1fr]">
                <Field label="Function">
                  <Input value={fun} onChange={(e) => setFun(e.target.value)} onFocus={loadFunctions} list="salt-functions" className="font-mono" placeholder="module.function" required />
                  <datalist id="salt-functions">
                    {functions.map((f) => (
                      <option key={f} value={f} />
                    ))}
                  </datalist>
                </Field>
                <Field label="Arguments" hint="Positional args and key=value kwargs. Quote values that contain spaces.">
                  <Input value={args} onChange={(e) => setArgs(e.target.value)} className="font-mono" placeholder={isCmd ? "'systemctl status nginx'" : 'webserver test=True'} />
                </Field>
              </div>

              <div className="flex flex-wrap items-center gap-2 border-t border-zinc-100 pt-4 dark:border-zinc-800">
                {PRESETS.map((p) => (
                  <button
                    type="button"
                    key={p.label}
                    onClick={() => {
                      setFun(p.fun)
                      setArgs(p.args ?? '')
                    }}
                    className={clsx(
                      'rounded-full border px-2.5 py-1 text-xs font-medium transition',
                      fun === p.fun && args === (p.args ?? '')
                        ? 'border-accent-500 bg-accent-50 text-accent-700 dark:bg-accent-700/20 dark:text-accent-400'
                        : 'border-zinc-200 text-zinc-600 hover:border-zinc-300 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800',
                    )}
                  >
                    {p.label}
                  </button>
                ))}
                <Button type="submit" variant={isWrite ? 'success' : 'primary'} className="ml-auto" icon={<Play className="size-4" />} loading={submitting} disabled={!allowed}>
                  {isWrite ? 'Apply' : 'Run'}
                  {matched?.length ? ` on ${matched.length}` : ''}
                  <CornerDownLeft className="size-3.5 opacity-60" />
                </Button>
              </div>
              {!allowed && <PermNote>Your eauth permissions don't allow running {fun.trim()}.</PermNote>}
              {isWrite && allowed && (
                <p className="flex items-center gap-1.5 text-xs text-amber-700 dark:text-amber-400">
                  <TriangleAlert className="size-3.5" /> This will change the targeted minions. Add <code className="font-mono">test=True</code> for a dry run.
                </p>
              )}
            </form>
          </Card>

          {error && <ErrorBox error={error} />}

          {run && (
            <Card>
              <CardHeader
                title={
                  <span className="flex flex-wrap items-center gap-2">
                    Results
                    <Badge tone={run.done ? (run.timedOut ? 'amber' : 'green') : 'blue'}>
                      {returned}/{run.minions.length} returned
                    </Badge>
                    {run.timedOut && <Badge tone="amber">incomplete</Badge>}
                  </span>
                }
                subtitle={<span className="font-mono">jid {run.jid}</span>}
                actions={
                  <div className="flex flex-wrap items-center gap-2">
                    {run.done && (
                      <ResultActions
                        job={{ jid: run.jid, fun: run.fun, target: ranWith?.tgt, targetType: ranWith?.tgtType }}
                        results={run.results}
                        expected={run.minions}
                        onRetry={retry}
                      />
                    )}
                    <Link to={`/jobs/${run.jid}`} className="inline-flex items-center gap-1 text-xs font-medium text-accent-700 hover:underline dark:text-accent-400">
                      Open job <ExternalLink className="size-3" />
                    </Link>
                  </div>
                }
              />
              <div className="p-3">
                <ResultView results={run.results} expected={run.done ? Object.keys(run.results) : run.minions} />
                {run.timedOut && (
                  <p className="mt-3 text-sm text-zinc-500">
                    Did not return: <span className="font-mono">{run.minions.filter((m) => !(m in run.results)).join(', ')}</span>
                  </p>
                )}
              </div>
            </Card>
          )}
        </div>

        <Card className="h-fit">
          <CardHeader title={<span className="flex items-center gap-2"><History className="size-4 text-zinc-500 dark:text-zinc-400" /> Recent</span>} />
          {history.length === 0 ? (
            <p className="p-4 text-sm text-zinc-500">Commands you run appear here.</p>
          ) : (
            <ul className="divide-y divide-zinc-100 dark:divide-zinc-800/70">
              {history.map((h, i) => (
                <li key={i}>
                  <button
                    className="w-full px-4 py-2 text-left hover:bg-zinc-50 dark:hover:bg-zinc-800/40"
                    onClick={() => {
                      setTgt(h.tgt)
                      setTgtType(h.tgt_type)
                      setFun(h.fun)
                      setArgs(h.args)
                    }}
                  >
                    <p className="truncate font-mono text-xs font-medium">
                      {h.fun} {h.args}
                    </p>
                    <p className="truncate font-mono text-[11px] text-zinc-500 dark:text-zinc-400">
                      {h.tgt_type !== 'glob' && `${h.tgt_type}:`}
                      {h.tgt}
                    </p>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <Modal open={confirming} onClose={() => setConfirming(false)} title="Confirm run">
        <div className="space-y-4 text-sm">
          <p>
            Run <code className="rounded bg-zinc-100 px-1 font-mono dark:bg-zinc-800">{`${fun.trim()} ${args}`.trim()}</code> on{' '}
            {matched ? (
              <strong>
                {matched.length} {matched.length === 1 ? 'minion' : 'minions'}
              </strong>
            ) : (
              <>
                target <code className="font-mono">{tgt}</code> <span className="text-zinc-500">(the number of matched minions is unknown)</span>
              </>
            )}
            ?
          </p>
          {matched && (
            <div className="flex max-h-32 flex-wrap gap-1 overflow-y-auto">
              {matched.map((m) => (
                <span key={m} className="rounded bg-zinc-100 px-1.5 py-0.5 font-mono text-xs dark:bg-zinc-800">
                  {m}
                </span>
              ))}
            </div>
          )}
          <p className="text-xs text-zinc-500">This changes the targeted minions. Most state and package functions accept test=True for a dry run.</p>
          {level === 'type' && (
            <Field label={`Type ${matched?.length} to confirm`}>
              <Input
                autoFocus
                inputMode="numeric"
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && typed === String(matched?.length) && execute()}
              />
            </Field>
          )}
          <div className="flex justify-end gap-2">
            <Button onClick={() => setConfirming(false)}>Cancel</Button>
            <Button
              variant="danger"
              icon={<Play className="size-4" />}
              autoFocus={level !== 'type'}
              disabled={level === 'type' && typed !== String(matched?.length)}
              onClick={execute}
            >
              Run on {matched ? matched.length : tgt}
            </Button>
          </div>
        </div>
      </Modal>
    </>
  )
}

