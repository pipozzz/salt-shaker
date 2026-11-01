import clsx from 'clsx'
import { CheckCircle2, ChevronRight, CircleDashed, Clock, Loader2, XCircle } from 'lucide-react'
import { useState } from 'react'
import { JsonView } from './JsonView'
import { Badge } from './ui'

interface StateRet {
  __id__?: string
  __sls__?: string
  __run_num__?: number
  name?: string
  result: boolean | null
  comment?: string
  changes?: Record<string, unknown>
  duration?: number
}

function asStates(ret: unknown): Array<[string, StateRet]> | null {
  if (!ret || typeof ret !== 'object' || Array.isArray(ret)) return null
  const entries = Object.entries(ret as Record<string, unknown>)
  if (entries.length === 0 || !entries.every(([k, v]) => k.includes('_|-') && v && typeof v === 'object' && 'result' in v)) return null
  return (entries as Array<[string, StateRet]>).sort((a, b) => (a[1].__run_num__ ?? 0) - (b[1].__run_num__ ?? 0))
}

export function stateSummary(ret: unknown) {
  const states = asStates(ret)
  if (!states) return null
  const s = { ok: 0, changed: 0, failed: 0, pending: 0, duration: 0 }
  for (const [, st] of states) {
    if (st.result === false) s.failed++
    else if (st.result === null) s.pending++
    else if (st.changes && Object.keys(st.changes).length) s.changed++
    else s.ok++
    s.duration += st.duration ?? 0
  }
  return s
}

/** Did a minion's return look like a failure? */
export function isFailure(ret: unknown) {
  const sum = stateSummary(ret)
  if (sum) return sum.failed > 0
  if (Array.isArray(ret) && ret.every((x) => typeof x === 'string')) return ret.some((x) => /^(Rendering SLS|No matching sls|Pillar failed)/.test(x))
  if (typeof ret === 'string') return /is not available|Traceback|ERROR|Minion did not return/.test(ret)
  return ret === false
}

export function ResultView({ results, expected }: { results: Record<string, unknown>; expected?: string[] }) {
  const ids = [...new Set([...(expected ?? []), ...Object.keys(results)])].sort()
  return (
    <div className="space-y-2">
      {ids.map((id) => (
        <MinionResult key={id} id={id} returned={id in results} ret={results[id]} defaultOpen={ids.length <= 3} />
      ))}
    </div>
  )
}

function MinionResult({ id, ret, returned, defaultOpen }: { id: string; ret: unknown; returned: boolean; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen)
  const sum = returned ? stateSummary(ret) : null
  const failed = returned && isFailure(ret)
  return (
    <div className="overflow-hidden rounded-lg border border-zinc-200 dark:border-zinc-800">
      <button
        onClick={() => returned && setOpen(!open)}
        className="flex w-full items-center gap-3 bg-zinc-50/80 px-3 py-2 text-left hover:bg-zinc-100/80 dark:bg-zinc-900 dark:hover:bg-zinc-800/60"
      >
        <ChevronRight className={clsx('size-4 text-zinc-400 transition-transform', open && 'rotate-90', !returned && 'invisible')} />
        {!returned ? (
          <Loader2 className="size-4 animate-spin text-zinc-400" />
        ) : failed ? (
          <XCircle className="size-4 text-red-500" />
        ) : (
          <CheckCircle2 className="size-4 text-emerald-500" />
        )}
        <span className="font-mono text-sm font-medium">{id}</span>
        <span className="ml-auto flex items-center gap-1.5">
          {!returned && <span className="text-xs text-zinc-500">waiting…</span>}
          {sum && (
            <>
              {sum.ok > 0 && <Badge tone="green">{sum.ok} ok</Badge>}
              {sum.changed > 0 && <Badge tone="blue">{sum.changed} changed</Badge>}
              {sum.pending > 0 && <Badge tone="amber">{sum.pending} would change</Badge>}
              {sum.failed > 0 && <Badge tone="red">{sum.failed} failed</Badge>}
              <span className="hidden text-xs text-zinc-500 tabular-nums sm:inline">{(sum.duration / 1000).toFixed(2)}s</span>
            </>
          )}
          {returned && !sum && <InlinePreview ret={ret} />}
        </span>
      </button>
      {open && returned && (
        <div className="border-t border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-950/40">
          {sum ? <StateList ret={ret} /> : <Raw ret={ret} />}
        </div>
      )}
    </div>
  )
}

function InlinePreview({ ret }: { ret: unknown }) {
  if (typeof ret === 'boolean') return <Badge tone={ret ? 'green' : 'red'}>{String(ret)}</Badge>
  if (typeof ret === 'string' && !ret.includes('\n') && ret.length < 40) return <span className="font-mono text-xs text-zinc-500">{ret}</span>
  return null
}

function Raw({ ret }: { ret: unknown }) {
  if (typeof ret === 'string') return <pre className="overflow-x-auto font-mono text-[12.5px] leading-5 whitespace-pre-wrap">{ret}</pre>
  if (ret === null || typeof ret !== 'object') return <JsonView value={{ return: ret }} />
  return <JsonView value={ret} />
}

export function StateList({ ret, interesting = false }: { ret: unknown; interesting?: boolean }) {
  const [onlyInteresting, setOnly] = useState(interesting)
  const states = asStates(ret) ?? []
  const shown = onlyInteresting ? states.filter(([, s]) => s.result !== true || (s.changes && Object.keys(s.changes).length)) : states
  return (
    <div className="space-y-1.5">
      <label className="mb-2 flex items-center gap-2 text-xs text-zinc-500">
        <input type="checkbox" checked={onlyInteresting} onChange={(e) => setOnly(e.target.checked)} className="accent-accent-600" />
        Only show changes and failures
      </label>
      {shown.map(([key, s]) => {
        const [mod, , , fun] = key.split('_|-')
        const changed = s.changes && Object.keys(s.changes).length > 0
        return (
          <div
            key={key}
            className={clsx(
              'rounded-md border-l-2 py-1.5 pr-2 pl-3',
              s.result === false ? 'border-red-500 bg-red-50/60 dark:bg-red-950/20' : s.result === null ? 'border-amber-500 bg-amber-50/50 dark:bg-amber-950/20' : changed ? 'border-sky-500 bg-sky-50/50 dark:bg-sky-950/20' : 'border-emerald-500/60',
            )}
          >
            <div className="flex flex-wrap items-center gap-x-2 text-sm">
              {s.result === false ? <XCircle className="size-3.5 text-red-500" /> : s.result === null ? <CircleDashed className="size-3.5 text-amber-500" /> : <CheckCircle2 className={clsx('size-3.5', changed ? 'text-sky-500' : 'text-emerald-500')} />}
              <span className="font-medium">{s.__id__}</span>
              <span className="font-mono text-xs text-zinc-500">
                {mod}.{fun}
              </span>
              {s.__sls__ && <span className="text-xs text-zinc-400">· {s.__sls__}</span>}
              {s.duration !== undefined && (
                <span className="ml-auto flex items-center gap-1 text-xs text-zinc-400 tabular-nums">
                  <Clock className="size-3" />
                  {s.duration.toFixed(0)} ms
                </span>
              )}
            </div>
            {s.comment && <p className="mt-0.5 text-xs whitespace-pre-wrap text-zinc-600 dark:text-zinc-400">{s.comment}</p>}
            {changed && (
              <div className="mt-1.5">
                <Changes changes={s.changes!} />
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

function Changes({ changes }: { changes: Record<string, unknown> }) {
  if (typeof changes.diff === 'string') {
    return (
      <pre className="overflow-x-auto rounded bg-zinc-50 p-2 font-mono text-xs leading-5 dark:bg-zinc-900">
        {(changes.diff as string).split('\n').map((l, i) => (
          <div key={i} className={clsx(l.startsWith('+') && !l.startsWith('+++') && 'text-emerald-600 dark:text-emerald-400', l.startsWith('-') && !l.startsWith('---') && 'text-red-600 dark:text-red-400', l.startsWith('@@') && 'text-sky-600')}>
            {l || ' '}
          </div>
        ))}
      </pre>
    )
  }
  return <JsonView value={changes} />
}
