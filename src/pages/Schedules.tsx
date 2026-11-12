import { useAutomationApi } from '../lib/automation'
import { OSQUERY_LIBRARY, checkQuery } from '../lib/osquery'
import { CalendarClock, ExternalLink, Pencil, Play, Plus, Trash2 } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { formatArgs, parseArgs } from '../api/salt'
import { type Schedule, type ScheduleInput, type ScheduleKind, type ScheduleRun } from '../api/server'
import type { TargetType } from '../api/types'
import { TargetField } from '../components/TargetField'
import { Badge, Button, Card, Empty, ErrorBox, Field, Input, Modal, PageHeader, Select, Spinner, Switch, type Tone } from '../components/ui'
import { useAsync } from '../lib/hooks'
import { useMaintenanceApi } from '../lib/maintenance'
import { useRunbooksApi } from '../lib/runbooks'
import { relTime } from '../lib/format'

const PRESETS: Array<[string, string]> = [
  ['0 * * * *', 'Every hour'],
  ['0 2 * * *', 'Every day at 02:00'],
  ['0 6 * * 1-5', 'Weekdays at 06:00'],
  ['0 6 * * 1', 'Mondays at 06:00'],
  ['0 3 1 * *', 'Monthly on the 1st at 03:00'],
]
const presetLabel = (cron: string) => PRESETS.find(([c]) => c === cron)?.[1]

const KIND_TONE: Record<ScheduleKind, Tone> = { compliance: 'accent', patches: 'blue', vulns: 'red', osquery: 'amber', function: 'zinc', runbook: 'green' }
const KIND_LABEL: Record<ScheduleKind, string> = { compliance: 'Compliance', patches: 'Patch scan', vulns: 'Vulnerability scan', osquery: 'osquery', function: 'Function', runbook: 'Runbook' }

/** "in 3h", "in 12m": relTime() only speaks about the past. */
function untilTime(d: Date) {
  const s = Math.round((d.getTime() - Date.now()) / 1000)
  if (s < 60) return 'in under a minute'
  if (s < 3600) return `in ${Math.floor(s / 60)}m`
  if (s < 86400) return `in ${Math.floor(s / 3600)}h`
  return `in ${Math.floor(s / 86400)}d`
}

function Summary({ s }: { s: Schedule }) {
  const sum = s.lastSummary
  if (!sum) return <span className="text-xs text-zinc-500 dark:text-zinc-400">{s.lastRunAt ? 'collecting results…' : 'never ran'}</span>
  if (typeof sum.error === 'string') return <span className="text-xs text-red-600 dark:text-red-400">{sum.error}</span>
  if (s.kind === 'runbook' && typeof sum.run === 'number') {
    const status = typeof sum.status === 'string' ? sum.status : ''
    const tone: Tone = status.startsWith('done') ? 'green' : status.startsWith('running') || status.startsWith('pending') ? 'blue' : status ? 'red' : 'zinc'
    return (
      <Link to={`/runbooks/runs/${sum.run}`} title={status}>
        <Badge tone={tone}>
          run #{sum.run}
          {status && ` · ${status.split(':')[0]}`}
        </Badge>
      </Link>
    )
  }
  if (s.kind === 'compliance') {
    const c = sum as { ok: number; drift: number; error: number; noreturn: number; remedyChange?: number; remedyMinions?: number; remedySkipped?: string }
    return (
      <span className="flex flex-wrap gap-1">
        <Badge tone="green">{c.ok} ok</Badge>
        {c.drift > 0 && <Badge tone="amber">{c.drift} drifted</Badge>}
        {c.error > 0 && <Badge tone="red">{c.error} {c.error === 1 ? 'error' : 'errors'}</Badge>}
        {c.noreturn > 0 && <Badge>{c.noreturn} no return</Badge>}
        {c.remedyChange && (
          <Link to={`/changes/${c.remedyChange}`} title={`Fixing ${c.remedyMinions} drifted ${c.remedyMinions === 1 ? 'minion' : 'minions'}`}>
            <Badge tone="blue">fixing in #{c.remedyChange}</Badge>
          </Link>
        )}
        {c.remedySkipped && <Badge title={`Not fixed: ${c.remedySkipped}`}>not fixed</Badge>}
      </span>
    )
  }
  if (s.kind === 'patches') {
    const p = sum as { needUpdates: number; packages: number; scanned: number }
    return p.needUpdates ? <Badge tone="amber">{p.needUpdates} minions · {p.packages} packages</Badge> : <Badge tone="green">up to date</Badge>
  }
  if (s.kind === 'vulns' && 'critical' in sum) {
    const v = sum as { scanned: number; critical: number; high: number; fixable: number }
    return (
      <Link to="/vulnerabilities" className="flex flex-wrap gap-1">
        {v.critical > 0 && <Badge tone="red">{v.critical} critical</Badge>}
        {v.high > 0 && <Badge tone="amber">{v.high} high</Badge>}
        {v.critical + v.high > 0 ? <Badge>{v.fixable} with a fix</Badge> : <Badge tone="green">nothing critical or high · {v.scanned} scanned</Badge>}
      </Link>
    )
  }
  if (s.kind === 'osquery' && 'baseline' in sum) {
    const d = sum as { baseline: boolean; rows: number; minions: number; added: number; removed: number; changedMinions: number; missing: number; failed: number; tooLarge?: number }
    return (
      <Link to={`/jobs/${s.lastJid}`} className="flex flex-wrap gap-1">
        {d.baseline ? (
          <Badge>first run · {d.rows} rows</Badge>
        ) : d.added + d.removed ? (
          <Badge tone="amber">
            {[d.added && `+${d.added}`, d.removed && `−${d.removed}`].filter(Boolean).join(' ')} on {d.changedMinions} {d.changedMinions === 1 ? 'minion' : 'minions'}
          </Badge>
        ) : (
          <Badge tone="green">no changes · {d.rows} rows</Badge>
        )}
        {d.failed > 0 && <Badge tone="red">{d.failed} failed</Badge>}
        {d.missing > 0 && <Badge>{d.missing} without osquery</Badge>}
        {(d.tooLarge ?? 0) > 0 && <Badge tone="amber">{d.tooLarge} too large to compare</Badge>}
      </Link>
    )
  }
  const f = sum as { returned: number; failed: number }
  return f.failed ? <Badge tone="red">{f.failed} failed</Badge> : <Badge tone="green">{f.returned} ok</Badge>
}

/** What a watched query's last run found new or gone, as listed in its notification. */
function QueryChanges({ s }: { s: Schedule }) {
  const d = s.kind === 'osquery' ? (s.lastSummary as { baseline?: boolean; added?: number; removed?: number; examples?: string[] } | null) : null
  if (!d || d.baseline || !d.examples?.length) return null
  const more = (d.added ?? 0) + (d.removed ?? 0) - d.examples.length
  return (
    <details className="basis-full pl-14 text-xs">
      <summary className="cursor-pointer text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100">What changed in the last run</summary>
      <ul className="mt-1 space-y-0.5 font-mono break-all">
        {d.examples.map((e) => (
          <li key={e} className={e.includes(': + ') ? 'text-emerald-700 dark:text-emerald-400' : 'text-red-700 dark:text-red-400'}>
            {e}
          </li>
        ))}
        {more > 0 && <li className="font-sans text-zinc-500 dark:text-zinc-400">… and {more} more in the job</li>}
      </ul>
    </details>
  )
}

const RUN_BAR: Record<ScheduleRun['status'], string> = {
  ok: 'bg-emerald-500',
  changed: 'bg-amber-400',
  failed: 'bg-red-500',
  noreturn: 'bg-zinc-400 dark:bg-zinc-500',
  running: 'animate-pulse bg-zinc-300 dark:bg-zinc-600',
}

function runLabel(kind: ScheduleKind, status: ScheduleRun['status']) {
  if (kind === 'runbook') return { ok: 'done', failed: 'stopped or failed', running: 'running', changed: 'changed', noreturn: 'no return' }[status]
  if (status === 'changed') return kind === 'patches' ? 'updates available' : 'drifted'
  return { ok: 'ok', failed: 'failed', noreturn: 'some minions did not return', running: 'running' }[status]
}

/** The latest runs as a strip of bars, oldest left, each linked to its job. */
function RecentRuns({ s }: { s: Schedule }) {
  const runs = s.recentRuns
  if (runs.length < 2) return null
  const failed = runs.filter((r) => r.status === 'failed').length
  return (
    <div className="flex items-center gap-2">
      <ul className="flex items-end gap-0.5" aria-label={`Last ${runs.length} runs`}>
        {runs.map((r) => {
          const text = `${relTime(new Date(r.startedAt))}: ${runLabel(s.kind, r.status)} (${r.detail})`
          return (
            <li key={r.jid}>
              <Link to={r.run ? `/runbooks/runs/${r.run}` : `/jobs/${r.jid}`} aria-label={text} title={text} className="-my-1 block py-1 hover:opacity-70">
                <span className={`block w-1.5 rounded-sm ${RUN_BAR[r.status]} ${r.status === 'failed' ? 'h-4' : 'h-3'}`} />
              </Link>
            </li>
          )
        })}
      </ul>
      <Link to={s.kind === 'runbook' ? '/runbooks' : `/jobs?q=${encodeURIComponent(`schedule:${s.name}`)}${failed ? '&result=failed' : ''}`} className="text-zinc-500 hover:text-accent-600 dark:text-zinc-400">
        {failed ? `${failed} of ${runs.length} failed` : 'history'}
      </Link>
    </div>
  )
}

export function SchedulesPage() {
  const api = useAutomationApi()
  const list = useAsync(() => api.schedules(), [])
  const meta = useAsync(() => api.meta(), [])
  // "Schedule…" on the Run page opens a new schedule for that function and target
  const [params, setParams] = useSearchParams()
  const fromRun = params.get('fun')
    ? { fun: params.get('fun')!, args: params.get('args') ?? '', tgt: params.get('tgt') ?? '*', tgtType: (params.get('tgt_type') as TargetType | null) ?? 'glob' }
    : params.get('sql')
      ? { fun: '', args: '', sql: params.get('sql')!, name: params.get('name') ?? '', tgt: params.get('tgt') ?? '*', tgtType: (params.get('tgt_type') as TargetType | null) ?? 'glob' }
      : null
  const [editing, setEditing] = useState<Schedule | 'new' | null>(fromRun ? 'new' : null)
  const closeEditor = () => {
    setEditing(null)
    if (fromRun) setParams({}, { replace: true })
  }
  const [removing, setRemoving] = useState<Schedule | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<Error | null>(null)
  const [started, setStarted] = useState<Record<number, string>>({})
  const windowsApi = useMaintenanceApi()
  const windows = useAsync(() => (windowsApi ? windowsApi.list() : Promise.resolve(null)), [windowsApi])
  const windowName = (id: number | null) => (id ? windows.data?.windows.find((w) => w.id === id)?.name : undefined)

  const act = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key)
    setError(null)
    try {
      await fn()
      await list.reload()
    } catch (e) {
      setError(e as Error)
    } finally {
      setBusy(null)
    }
  }

  return (
    <>
      <PageHeader
        title="Schedules"
        description={
          <>
            Compliance checks, patch and vulnerability scans, watched osquery queries, runbooks or any function, run by the server on a schedule. Times are in the server's time zone ({meta.data?.timezone ?? '…'}). Results go to{' '}
            <Link to="/notifications" className="text-accent-700 underline underline-offset-2 hover:text-accent-800 dark:text-accent-400 dark:hover:text-accent-100">
              Notifications
            </Link>
            .
          </>
        }
        actions={
          <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setEditing('new')}>
            New schedule
          </Button>
        }
      />
      {error && (
        <div className="mb-4">
          <ErrorBox error={error} />
        </div>
      )}
      <Card>
        {list.error && (
          <div className="p-4">
            <ErrorBox error={list.error} onRetry={list.reload} />
          </div>
        )}
        {list.loading && !list.data && <Spinner />}
        {list.data && list.data.schedules.length === 0 && (
          <Empty icon={<CalendarClock />} title="No schedules yet">
            A nightly compliance check is a good first one: you'll hear about drift before it becomes an incident.
          </Empty>
        )}
        {list.data && list.data.schedules.length > 0 && (
          <ul className="divide-y divide-zinc-100 dark:divide-zinc-800/70">
            {list.data.schedules.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
                <Switch checked={s.enabled} label={`Enable ${s.name}`} disabled={busy === `toggle:${s.id}`} onChange={(v) => act(`toggle:${s.id}`, () => api.updateSchedule(s.id, { enabled: v }))} />
                <div className="min-w-48 flex-1">
                  <p className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{s.name}</span>
                    <Badge tone={KIND_TONE[s.kind]}>{KIND_LABEL[s.kind]}</Badge>
                  </p>
                  {s.kind === 'runbook' ? (
                    <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
                      {s.runbookName ? (
                        <Link to="/runbooks" className="font-medium text-zinc-700 hover:text-accent-600 dark:text-zinc-300">
                          {s.runbookName}
                        </Link>
                      ) : (
                        <span className="text-red-600 dark:text-red-400">its runbook is gone</span>
                      )}
                      {Object.entries(s.args?.params ?? {}).map(([k, v]) => (
                        <span key={k} className="ml-2 font-mono">
                          {k}={v}
                        </span>
                      ))}
                    </p>
                  ) : (
                  <p className="mt-0.5 font-mono text-xs text-zinc-500 dark:text-zinc-400">
                    {s.kind === 'function' && `${s.fun} ${formatArgs([...(s.args?.arg ?? []), ...(s.args?.kwarg && Object.keys(s.args.kwarg).length ? [{ __kwarg__: true, ...s.args.kwarg }] : [])])} → `}
                    {s.targetType !== 'glob' && `${s.targetType}:`}
                    {s.target}
                  </p>
                  )}
                </div>
                <div className="w-44 text-xs">
                  <p className="font-medium text-zinc-700 dark:text-zinc-300">{presetLabel(s.cron) ?? <span className="font-mono">{s.cron}</span>}</p>
                  <p className="text-zinc-500 dark:text-zinc-400">
                    {s.cronError ? <span className="text-red-600">{s.cronError}</span> : s.nextRunAt ? `next ${untilTime(new Date(s.nextRunAt))}` : 'paused'}
                  </p>
                  {s.remedy && <p className="text-zinc-500 dark:text-zinc-400">fixes drift{s.remedy.batchSize ? `, ${s.remedy.batchSize} at a time` : ''}</p>}
                  {windowName(s.windowId) && (
                    <p className="text-zinc-500 dark:text-zinc-400" title="Waits for this maintenance window when it comes due outside it">
                      in <span className="font-medium text-zinc-700 dark:text-zinc-300">{windowName(s.windowId)}</span>
                    </p>
                  )}
                </div>
                <div className="w-52 space-y-1 text-xs">
                  <Summary s={s} />
                  <RecentRuns s={s} />
                  {s.lastRunAt && (
                    <p className="text-zinc-500 dark:text-zinc-400">
                      {relTime(new Date(s.lastRunAt))}
                      {s.lastJid && (
                        <>
                          {' · '}
                          <Link to={`/jobs/${s.lastJid}`} className="inline-flex items-center gap-0.5 hover:text-accent-600">
                            job <ExternalLink className="size-3" />
                          </Link>
                        </>
                      )}
                    </p>
                  )}
                  {started[s.id] && (
                    <p>
                      <Link to={started[s.id]} className="text-accent-700 underline underline-offset-2 hover:text-accent-800 dark:text-accent-400 dark:hover:text-accent-100">
                        Started just now →
                      </Link>
                    </p>
                  )}
                </div>
                <div className="flex gap-1">
                  <Button
                    size="sm"
                    variant="ghost"
                    icon={<Play className="size-3.5" />}
                    loading={busy === `run:${s.id}`}
                    onClick={() =>
                      act(`run:${s.id}`, async () => {
                        const r = await api.runSchedule(s.id)
                        setStarted((m) => ({ ...m, [s.id]: 'jid' in r ? `/jobs/${r.jid}` : `/runbooks/runs/${r.run}` }))
                      })
                    }
                  >
                    Run now
                  </Button>
                  <Button size="sm" variant="ghost" icon={<Pencil className="size-3.5" />} onClick={() => setEditing(s)}>
                    Edit
                  </Button>
                  <Button size="sm" variant="ghost" icon={<Trash2 className="size-3.5" />} onClick={() => setRemoving(s)} aria-label={`Delete ${s.name}`} />
                </div>
                <QueryChanges s={s} />
              </li>
            ))}
          </ul>
        )}
      </Card>

      {editing && <ScheduleModal schedule={editing === 'new' ? null : editing} draft={editing === 'new' ? fromRun : null} kinds={meta.data?.kinds} onClose={closeEditor} onSaved={list.reload} />}

      <Modal open={!!removing} onClose={() => setRemoving(null)} title="Delete schedule?">
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          <strong>{removing?.name}</strong> stops running. Jobs it already ran stay in the history.
        </p>
        <div className="mt-5 flex justify-end gap-2">
          <Button onClick={() => setRemoving(null)}>Cancel</Button>
          <Button
            variant="danger"
            icon={<Trash2 className="size-4" />}
            loading={busy === 'delete'}
            onClick={async () => {
              await act('delete', () => api.deleteSchedule(removing!.id))
              setRemoving(null)
            }}
          >
            Delete
          </Button>
        </div>
      </Modal>
    </>
  )
}

interface Draft {
  fun: string
  args: string
  /** from the Query page: an osquery schedule */
  sql?: string
  name?: string
  tgt: string
  tgtType: TargetType
}

function ScheduleModal({ schedule, draft, kinds, onClose, onSaved }: { schedule: Schedule | null; draft?: Draft | null; kinds?: Record<ScheduleKind, string>; onClose: () => void; onSaved: () => void }) {
  const api = useAutomationApi()
  const [name, setName] = useState(schedule?.name ?? (draft ? (draft.sql !== undefined ? draft.name || 'Watch query' : `${draft.fun} on ${draft.tgt}`) : ''))
  const [kind, setKind] = useState<ScheduleKind>(schedule?.kind ?? (draft ? (draft.sql !== undefined ? 'osquery' : 'function') : 'compliance'))
  const [sql, setSql] = useState(schedule?.args?.sql ?? draft?.sql ?? OSQUERY_LIBRARY[0].sql)
  const sqlError = kind === 'osquery' ? checkQuery(sql) : null
  const [tgt, setTgt] = useState(schedule?.target ?? draft?.tgt ?? '*')
  const [tgtType, setTgtType] = useState<TargetType>((schedule?.targetType as TargetType) ?? draft?.tgtType ?? 'glob')
  const [fun, setFun] = useState(schedule?.fun ?? draft?.fun ?? '')
  const [args, setArgs] = useState(
    schedule?.args ? formatArgs([...(schedule.args.arg ?? []), ...(schedule.args.kwarg && Object.keys(schedule.args.kwarg).length ? [{ __kwarg__: true, ...schedule.args.kwarg }] : [])]) : (draft?.args ?? ''),
  )
  const initialCron = schedule?.cron ?? '0 2 * * *'
  const [preset, setPreset] = useState(presetLabel(initialCron) ? initialCron : 'custom')
  const [cron, setCron] = useState(initialCron)
  const [windowId, setWindowId] = useState<number | null>(schedule?.windowId ?? null)
  const [fixDrift, setFixDrift] = useState(!!schedule?.remedy)
  const [batchSize, setBatchSize] = useState(schedule?.remedy?.batchSize ?? '25%')
  const [maxFailures, setMaxFailures] = useState(schedule?.remedy?.maxFailures ?? 0)
  const windowsApi = useMaintenanceApi()
  const windows = useAsync(() => (windowsApi ? windowsApi.list() : Promise.resolve(null)), [windowsApi])
  const runbooksApi = useRunbooksApi()
  const runbookList = useAsync(() => (runbooksApi ? runbooksApi.list() : Promise.resolve(null)), [runbooksApi])
  const [runbookId, setRunbookId] = useState<number | null>(schedule?.args?.runbookId ?? null)
  const runbook = runbookList.data?.runbooks.find((rb) => rb.id === runbookId) ?? (runbookId === null ? runbookList.data?.runbooks[0] : undefined)
  const [values, setValues] = useState<Record<string, string>>(schedule?.args?.params ?? {})
  const [error, setError] = useState<Error | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    const input: ScheduleInput = {
      name: name.trim(),
      kind,
      target: tgt.trim(),
      targetType: tgtType,
      cron: (preset === 'custom' ? cron : preset).trim(),
      windowId,
      remedy: kind === 'compliance' && fixDrift ? { batchSize: batchSize.trim() || null, maxFailures } : null,
      ...(kind === 'function'
        ? { fun: fun.trim(), args: parseArgs(args) }
        : kind === 'osquery'
          ? { args: { sql: sql.trim() } }
          : kind === 'runbook'
            ? { args: { runbookId: runbook?.id ?? 0, params: Object.fromEntries((runbook?.params ?? []).map((p) => [p.name, values[p.name] ?? p.default])) } }
            : {}),
    }
    try {
      if (schedule) await api.updateSchedule(schedule.id, input)
      else await api.createSchedule(input)
      onSaved()
      onClose()
    } catch (err) {
      setError(err as Error)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal open onClose={onClose} title={schedule ? `Edit ${schedule.name}` : 'New schedule'} wide>
      <form onSubmit={submit} className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Nightly compliance" required autoFocus />
          </Field>
          <Field label="What to run">
            <Select value={kind} onChange={(e) => setKind(e.target.value as ScheduleKind)}>
              {Object.entries(kinds ?? { compliance: 'Compliance check', patches: 'Patch scan', function: 'Any function' }).map(([k, label]) => (
                <option key={k} value={k}>
                  {label}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        {kind === 'compliance' && (
          <div className="space-y-3 rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={fixDrift} onChange={(e) => setFixDrift(e.target.checked)} className="accent-accent-600" />
              Fix the drift it finds
              <span className="text-xs text-zinc-500 dark:text-zinc-400">applies the highstate to the drifted minions, as a change</span>
            </label>
            {fixDrift && (
              <>
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="Batch size" hint="Minions at a time: a number, or a share like 25%">
                    <Input value={batchSize} onChange={(e) => setBatchSize(e.target.value)} className="font-mono" aria-label="Batch size" />
                  </Field>
                  <Field label="Failures allowed" hint="It stops when more minions than this have failed">
                    <Input type="number" min={0} value={maxFailures} onChange={(e) => setMaxFailures(Math.max(0, Number(e.target.value) || 0))} aria-label="Failures allowed" />
                  </Field>
                </div>
                <p className="text-xs text-zinc-500 dark:text-zinc-400">
                  Minions with errors are left for a person. With a window under <strong>Only in</strong>, the check and the fix both happen inside it; a new fix waits until the last one has finished.
                </p>
              </>
            )}
          </div>
        )}
        {kind === 'function' && (
          <div className="grid gap-4 sm:grid-cols-[minmax(0,220px)_1fr]">
            <Field label="Function">
              <Input value={fun} onChange={(e) => setFun(e.target.value)} className="font-mono" placeholder="saltutil.sync_all" required />
            </Field>
            <Field label="Arguments" hint="Positional args and key=value kwargs, as on the Run page.">
              <Input value={args} onChange={(e) => setArgs(e.target.value)} className="font-mono" />
            </Field>
          </div>
        )}
        {kind === 'osquery' && (
          <div className="space-y-2">
            <Field label="Query" hint={sqlError && sql.trim() ? sqlError : 'Each run is compared with the previous one; new or gone rows trigger the “Query changes” notification.'}>
              <textarea
                value={sql}
                onChange={(e) => setSql(e.target.value)}
                rows={5}
                spellCheck={false}
                aria-label="Query"
                className="w-full rounded-lg border border-zinc-200 bg-white p-2 font-mono text-xs [font-variant-ligatures:none] focus:border-accent-500 focus:outline-none dark:border-zinc-800 dark:bg-zinc-900"
              />
            </Field>
            <Select aria-label="Start from the library" value="" onChange={(e) => e.target.value && setSql(e.target.value)} className="w-auto text-xs">
              <option value="">Start from the library…</option>
              {OSQUERY_LIBRARY.map((l) => (
                <option key={l.name} value={l.sql}>
                  {l.name}
                </option>
              ))}
            </Select>
          </div>
        )}
        {kind === 'runbook' && (
          <div className="space-y-3 rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
            {runbookList.data && !runbookList.data.runbooks.length ? (
              <p className="text-sm text-zinc-600 dark:text-zinc-400">
                There are no runbooks yet.{' '}
                <Link to="/runbooks" className="text-accent-700 underline underline-offset-2 dark:text-accent-400">
                  Write one first
                </Link>
                .
              </p>
            ) : (
              <Field label="Runbook" hint={runbook?.description || undefined}>
                <Select value={runbook?.id ?? ''} onChange={(e) => setRunbookId(Number(e.target.value))} aria-label="Runbook">
                  {runbookId !== null && !runbook && <option value="">(deleted)</option>}
                  {runbookList.data?.runbooks.map((rb) => (
                    <option key={rb.id} value={rb.id}>
                      {rb.name}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
            {!!runbook?.params.length && (
              <div className="grid gap-3 sm:grid-cols-2">
                {runbook.params.map((p) => (
                  <Field key={p.name} label={p.label || p.name} hint={`{{${p.name}}}${p.required ? ', required' : ''}`}>
                    <Input value={values[p.name] ?? p.default} onChange={(e) => setValues((v) => ({ ...v, [p.name]: e.target.value }))} className="font-mono" aria-label={p.label || p.name} />
                  </Field>
                ))}
              </div>
            )}
            <p className="text-xs text-zinc-500 dark:text-zinc-400">
              Each run goes step by step on its own page and is audited as <span className="font-mono">schedule:{name.trim() || '…'}</span>, with an admin's rights like every schedule. A new run waits until the last one has finished; how it ended goes to the <strong>Runbook runs</strong> notification.
            </p>
          </div>
        )}
        {kind !== 'runbook' && (
          <TargetField
            tgt={tgt}
            tgtType={tgtType}
            onChange={(t, tt) => {
              setTgt(t)
              setTgtType(tt)
            }}
          />
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="When">
            <Select value={preset} onChange={(e) => setPreset(e.target.value)}>
              {PRESETS.map(([c, label]) => (
                <option key={c} value={c}>
                  {label}
                </option>
              ))}
              <option value="custom">Custom (cron)…</option>
            </Select>
          </Field>
          {preset === 'custom' && (
            <Field label="Cron expression" hint="minute hour day month weekday, e.g. 30 1 * * 6">
              <Input value={cron} onChange={(e) => setCron(e.target.value)} className="font-mono" required />
            </Field>
          )}
          {!!windows.data?.windows.length && (
            <Field label="Only in" hint="Due outside the window, it waits for the window to open.">
              <Select value={windowId ?? ''} onChange={(e) => setWindowId(e.target.value ? Number(e.target.value) : null)} aria-label="Maintenance window">
                <option value="">Any time</option>
                {windows.data.windows.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
              </Select>
            </Field>
          )}
        </div>
        {error && <ErrorBox error={error} />}
        <div className="flex justify-end gap-2">
          <Button type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" loading={busy} disabled={!!sqlError}>
            {schedule ? 'Save' : 'Create schedule'}
          </Button>
        </div>
      </form>
    </Modal>
  )
}
