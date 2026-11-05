import clsx from 'clsx'
import { CheckCircle2, ChevronRight, Layers, Play, CircleDashed, Clock, Download, Loader2, RotateCcw, XCircle } from 'lucide-react'
import { useMemo, useState } from 'react'
import { JsonView } from './JsonView'
import { groupByOutput, type OutputGroup } from '../lib/group'
import { asStates, isFailure, stateSummary } from '../lib/states'
import { download, resultsCsv, resultsJson, retryTargets } from '../lib/export'
import { usePaged } from '../lib/hooks'
import { Badge, Button, CopyButton, ShowMore, Tabs } from './ui'

type Show = 'all' | 'failed' | 'waiting'

/** `onRunOn` (when the viewer may run the job) opens Run on a group's minions. */
export function ResultView({ results, expected, onRunOn }: { results: Record<string, unknown>; expected?: string[]; onRunOn?: (minions: string[]) => void }) {
  const ids = useMemo(() => [...new Set([...(expected ?? []), ...Object.keys(results)])].sort(), [expected, results])
  const failed = useMemo(() => ids.filter((id) => id in results && isFailure(results[id])), [ids, results])
  const waiting = ids.filter((id) => !(id in results))
  const [show, setShow] = useState<Show>('all')
  const list = show === 'failed' ? failed : show === 'waiting' ? waiting : ids
  // failures first, so a big run's problems aren't buried on page five
  const ordered = useMemo(() => (show === 'all' ? [...failed, ...list.filter((id) => !failed.includes(id))] : list), [show, failed, list])
  const paged = usePaged(ordered, show, 50)
  const many = ids.length > 10
  // minions that returned the same thing, e.g. one package version across the fleet
  const groups = useMemo(() => groupByOutput(results), [results])
  const [byOutput, setByOutput] = useState(false)
  const grouped = byOutput && groups

  return (
    <div className="space-y-2">
      {groups && (
        <div className="flex flex-wrap items-center gap-3 pb-1 text-sm">
          <Tabs
            value={grouped ? 'output' : 'minion'}
            onChange={(v) => setByOutput(v === 'output')}
            items={[
              { value: 'minion', label: 'By minion' },
              { value: 'output', label: `By output (${groups.length})` },
            ]}
          />
          {grouped && (
            <span className="text-zinc-600 dark:text-zinc-400">
              {groups.length} different {groups.length === 1 ? 'output' : 'outputs'} from {Object.keys(results).length} minions
              {waiting.length > 0 && `, ${waiting.length} still waiting`}
            </span>
          )}
        </div>
      )}
      {grouped && groups.map((g) => <GroupResult key={g.key} group={g} defaultOpen={groups.length <= 3} onRunOn={onRunOn} />)}
      {!grouped && many && (
        <div className="flex flex-wrap items-center gap-3 pb-1 text-sm">
          <span className="text-zinc-600 tabular-nums dark:text-zinc-400">
            {ids.length - failed.length - waiting.length} ok · {failed.length} failed · {waiting.length} waiting
          </span>
          <Tabs
            value={show}
            onChange={setShow}
            items={[
              { value: 'all', label: `All ${ids.length}` },
              { value: 'failed', label: `Failed ${failed.length}` },
              { value: 'waiting', label: `Waiting ${waiting.length}` },
            ]}
          />
        </div>
      )}
      {!grouped && (
        <>
          {paged.visible.map((id) => (
            <MinionResult key={id} id={id} returned={id in results} ret={results[id]} defaultOpen={ids.length <= 3} />
          ))}
          {many && list.length === 0 && <p className="py-4 text-center text-sm text-zinc-500 dark:text-zinc-400">None</p>}
          <ShowMore paged={paged} />
        </>
      )}
    </div>
  )
}

/**
 * Follow-ups for a finished job: run it again on the minions that failed or never returned
 * (when the caller can), and save the results as CSV or JSON.
 */
export function ResultActions({
  job,
  results,
  expected,
  onRetry,
}: {
  job: { jid: string; fun: string; target?: string; targetType?: string }
  results: Record<string, unknown>
  expected: string[]
  onRetry?: (minions: string[]) => void
}) {
  const retry = useMemo(() => retryTargets(results, expected), [results, expected])
  const name = `job-${job.jid}`
  return (
    <div className="flex flex-wrap items-center gap-1">
      {onRetry && retry.length > 0 && (
        <Button size="sm" icon={<RotateCcw className="size-3.5" />} onClick={() => onRetry(retry)} title={retry.join(', ')}>
          Retry {retry.length} failed
        </Button>
      )}
      <Button size="sm" variant="ghost" icon={<Download className="size-3.5" />} onClick={() => download(`${name}.csv`, 'text/csv', resultsCsv(results, expected))} aria-label="Download results as CSV">
        CSV
      </Button>
      <Button size="sm" variant="ghost" icon={<Download className="size-3.5" />} onClick={() => download(`${name}.json`, 'application/json', resultsJson(job, results, expected))} aria-label="Download results as JSON">
        JSON
      </Button>
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
        <ChevronRight className={clsx('size-4 text-zinc-500 transition-transform dark:text-zinc-400', open && 'rotate-90', !returned && 'invisible')} />
        {!returned ? (
          <Loader2 className="size-4 animate-spin text-zinc-500 dark:text-zinc-400" />
        ) : failed ? (
          <XCircle className="size-4 text-red-500" />
        ) : (
          <CheckCircle2 className="size-4 text-emerald-500" />
        )}
        <span className="font-mono text-sm font-medium">{id}</span>
        <span className="ml-auto flex items-center gap-1.5">
          {!returned && <span className="text-xs text-zinc-500 dark:text-zinc-400">waiting…</span>}
          {sum && (
            <>
              {sum.ok > 0 && <Badge tone="green">{sum.ok} ok</Badge>}
              {sum.changed > 0 && <Badge tone="blue">{sum.changed} changed</Badge>}
              {sum.pending > 0 && <Badge tone="amber">{sum.pending} would change</Badge>}
              {sum.failed > 0 && <Badge tone="red">{sum.failed} failed</Badge>}
              <span className="hidden text-xs text-zinc-500 tabular-nums sm:inline dark:text-zinc-400">{(sum.duration / 1000).toFixed(2)}s</span>
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

const GROUP_IDS = 30

/** One output and every minion that returned it. */
function GroupResult({ group, defaultOpen, onRunOn }: { group: OutputGroup; defaultOpen: boolean; onRunOn?: (minions: string[]) => void }) {
  const [open, setOpen] = useState(defaultOpen)
  const [allIds, setAllIds] = useState(false)
  const n = group.ids.length
  const ids = allIds ? group.ids : group.ids.slice(0, GROUP_IDS)
  return (
    <div className="overflow-hidden rounded-lg border border-zinc-200 dark:border-zinc-800">
      <button
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="flex w-full items-center gap-3 bg-zinc-50/80 px-3 py-2 text-left hover:bg-zinc-100/80 dark:bg-zinc-900 dark:hover:bg-zinc-800/60"
      >
        <ChevronRight className={clsx('size-4 text-zinc-500 transition-transform dark:text-zinc-400', open && 'rotate-90')} />
        {group.failed ? <XCircle className="size-4 shrink-0 text-red-500" /> : <Layers className="size-4 shrink-0 text-zinc-500 dark:text-zinc-400" />}
        <Badge tone={group.failed ? 'red' : 'zinc'}>
          {n} {n === 1 ? 'minion' : 'minions'}
        </Badge>
        <span className="min-w-0 truncate font-mono text-xs text-zinc-500 dark:text-zinc-400">{group.ids.slice(0, 3).join(', ') + (n > 3 ? ` +${n - 3}` : '')}</span>
        <span className="ml-auto flex shrink-0 items-center">
          <InlinePreview ret={group.ret} />
        </span>
      </button>
      {open && (
        <div className="space-y-3 border-t border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-950/40">
          <p className="flex flex-wrap gap-1">
            {ids.map((id) => (
              <span key={id} className="rounded bg-zinc-100 px-1.5 py-0.5 font-mono text-xs dark:bg-zinc-800">
                {id}
              </span>
            ))}
            {n > ids.length && (
              <button onClick={() => setAllIds(true)} className="px-1.5 text-xs text-accent-700 hover:underline dark:text-accent-400">
                +{n - ids.length} more
              </button>
            )}
          </p>
          <div className="flex flex-wrap gap-1">
            {onRunOn && (
              <Button size="sm" icon={<Play className="size-3.5" />} onClick={() => onRunOn(group.ids)}>
                Run on these {n}
              </Button>
            )}
            <CopyButton text={group.ids.join(',')} label="Copy IDs" />
          </div>
          <Raw ret={group.ret} />
        </div>
      )}
    </div>
  )
}

function InlinePreview({ ret }: { ret: unknown }) {
  if (typeof ret === 'boolean') return <Badge tone={ret ? 'green' : 'red'}>{String(ret)}</Badge>
  if (typeof ret === 'string' && !ret.includes('\n') && ret.length < 40) return <span className="font-mono text-xs text-zinc-500 dark:text-zinc-400">{ret}</span>
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
      <label className="mb-2 flex items-center gap-2 text-xs text-zinc-500 dark:text-zinc-400">
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
              <span className="font-mono text-xs text-zinc-500 dark:text-zinc-400">
                {mod}.{fun}
              </span>
              {s.__sls__ && <span className="text-xs text-zinc-500 dark:text-zinc-400">· {s.__sls__}</span>}
              {s.duration !== undefined && (
                <span className="ml-auto flex items-center gap-1 text-xs text-zinc-500 tabular-nums dark:text-zinc-400">
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
          <div key={i} className={clsx(l.startsWith('+') && !l.startsWith('+++') && 'text-emerald-700 dark:text-emerald-400', l.startsWith('-') && !l.startsWith('---') && 'text-red-600 dark:text-red-400', l.startsWith('@@') && 'text-sky-600')}>
            {l || ' '}
          </div>
        ))}
      </pre>
    )
  }
  return <JsonView value={changes} />
}
