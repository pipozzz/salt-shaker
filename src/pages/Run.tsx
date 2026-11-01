import clsx from 'clsx'
import { Crosshair, CornerDownLeft, ExternalLink, History, Loader2, Play, TriangleAlert } from 'lucide-react'
import { useEffect, useState, type FormEvent } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { parseArgs } from '../api/salt'
import type { TargetType } from '../api/types'
import { ResultView } from '../components/ResultView'
import { Badge, Button, Card, CardHeader, ErrorBox, Field, Input, PageHeader, Select } from '../components/ui'
import { useStoredState } from '../lib/hooks'
import { useSalt } from '../lib/session'
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

const TARGET_HINTS: Record<TargetType, string> = {
  glob: 'web-*  ·  *',
  list: 'web-01,db-01',
  grain: 'os:Ubuntu  ·  roles:web',
  compound: 'G@os:Debian and web*',
  pcre: '^(web|db)-0[12]$',
  pillar: 'env:prod',
  nodegroup: 'webservers',
}

interface HistoryItem {
  tgt: string
  tgt_type: TargetType
  fun: string
  args: string
  at: number
}

interface Preview {
  key: string
  minions?: string[]
  error?: boolean
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
  const [preview, setPreview] = useState<Preview | null>(null)

  // debounced "who would this hit?" lookup against the master's cache
  const previewKey = `${tgtType}\u0000${tgt.trim()}`
  useEffect(() => {
    if (!tgt.trim()) return
    let alive = true
    const t = setTimeout(() => {
      salt
        .matchTarget(tgt.trim(), tgtType)
        .then((minions) => alive && setPreview({ key: previewKey, minions }))
        .catch(() => alive && setPreview({ key: previewKey, error: true }))
    }, 400)
    return () => {
      alive = false
      clearTimeout(t)
    }
  }, [salt, tgt, tgtType, previewKey])
  const currentPreview = preview?.key === previewKey ? preview : null

  const loadFunctions = async () => {
    if (functions.length) return
    try {
      const { up } = await salt.status()
      if (up[0]) setFunctions(await salt.functions(up[0]))
    } catch {
      // autocomplete is best-effort
    }
  }

  const isWrite = /^state\.(apply|highstate|sls)$/.test(fun) && !/test=(True|true)/.test(args)
  const isCmd = fun.startsWith('cmd.')

  const submit = async (e?: FormEvent) => {
    e?.preventDefault()
    setError(null)
    setSubmitting(true)
    try {
      const { arg, kwarg } = parseArgs(args)
      await start(tgt, tgtType, fun.trim(), arg, kwarg)
      setHistory((h) => [{ tgt, tgt_type: tgtType, fun, args, at: Date.now() }, ...h.filter((x) => !(x.tgt === tgt && x.fun === fun && x.args === args && x.tgt_type === tgtType))].slice(0, 12))
    } catch (err) {
      setError(err as Error)
    } finally {
      setSubmitting(false)
    }
  }

  const returned = run ? Object.keys(run.results).length : 0

  return (
    <>
      <PageHeader title="Run" description="Execute any execution module on a set of minions. Jobs run asynchronously and show up in Jobs." />

      <div className="grid gap-6 xl:grid-cols-[1fr_280px]">
        <div className="min-w-0 space-y-6">
          <Card>
            <form onSubmit={submit} className="space-y-4 p-4">
              <div className="grid gap-4 sm:grid-cols-[1fr_160px]">
                <Field label="Target" hint={<TargetPreview hint={TARGET_HINTS[tgtType]} preview={tgt.trim() ? currentPreview : null} />}>
                  <Input value={tgt} onChange={(e) => setTgt(e.target.value)} className="font-mono" required />
                </Field>
                <Field label="Match by">
                  <Select value={tgtType} onChange={(e) => setTgtType(e.target.value as TargetType)}>
                    {Object.keys(TARGET_HINTS).map((t) => (
                      <option key={t} value={t}>
                        {t}
                      </option>
                    ))}
                  </Select>
                </Field>
              </div>
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
                <Button type="submit" variant={isWrite ? 'success' : 'primary'} className="ml-auto" icon={<Play className="size-4" />} loading={submitting}>
                  {isWrite ? 'Apply' : 'Run'}
                  {currentPreview?.minions?.length ? ` on ${currentPreview.minions.length}` : ''}
                  <CornerDownLeft className="size-3.5 opacity-60" />
                </Button>
              </div>
              {isWrite && (
                <p className="flex items-center gap-1.5 text-xs text-amber-600 dark:text-amber-400">
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
                  <Link to={`/jobs/${run.jid}`} className="inline-flex items-center gap-1 text-xs font-medium text-accent-600 hover:underline dark:text-accent-400">
                    Open job <ExternalLink className="size-3" />
                  </Link>
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
          <CardHeader title={<span className="flex items-center gap-2"><History className="size-4 text-zinc-400" /> Recent</span>} />
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
                    <p className="truncate font-mono text-[11px] text-zinc-500">
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
    </>
  )
}

function TargetPreview({ hint, preview }: { hint: string; preview: Preview | null }) {
  const [expanded, setExpanded] = useState(false)
  if (!preview) {
    return (
      <span className="flex items-center gap-2">
        <span className="font-mono">{hint}</span>
        <Loader2 className="size-3 animate-spin text-zinc-400" />
      </span>
    )
  }
  if (preview.error || !preview.minions) return <span className="font-mono">{hint}</span>
  const { minions } = preview
  if (minions.length === 0) {
    return (
      <span className="flex items-center gap-1.5 text-amber-600 dark:text-amber-400">
        <TriangleAlert className="size-3.5" /> Matches no known minions
      </span>
    )
  }
  const shown = expanded ? minions : minions.slice(0, 6)
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      <Crosshair className="size-3.5 text-accent-600 dark:text-accent-400" />
      <span className="font-medium text-zinc-700 dark:text-zinc-300">
        {minions.length} {minions.length === 1 ? 'minion' : 'minions'}:
      </span>
      {shown.map((m) => (
        <span key={m} className="rounded bg-zinc-100 px-1.5 font-mono text-[11px] text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
          {m}
        </span>
      ))}
      {minions.length > shown.length && (
        <button type="button" onClick={() => setExpanded(true)} className="text-accent-600 hover:underline dark:text-accent-400">
          +{minions.length - shown.length} more
        </button>
      )}
    </span>
  )
}
