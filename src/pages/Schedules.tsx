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
import { relTime } from '../lib/format'

const PRESETS: Array<[string, string]> = [
  ['0 * * * *', 'Every hour'],
  ['0 2 * * *', 'Every day at 02:00'],
  ['0 6 * * 1-5', 'Weekdays at 06:00'],
  ['0 6 * * 1', 'Mondays at 06:00'],
  ['0 3 1 * *', 'Monthly on the 1st at 03:00'],
]
const presetLabel = (cron: string) => PRESETS.find(([c]) => c === cron)?.[1]

const KIND_TONE: Record<ScheduleKind, Tone> = { compliance: 'accent', patches: 'blue', vulns: 'red', osquery: 'amber', function: 'zinc' }
const KIND_LABEL: Record<ScheduleKind, string> = { compliance: 'Compliance', patches: 'Patch scan', vulns: 'Vulnerability scan', osquery: 'osquery', function: 'Function' }

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
  if (s.kind === 'compliance') {
    const c = sum as { ok: number; drift: number; error: number; noreturn: number }
    return (
      <span className="flex flex-wrap gap-1">
        <Badge tone="green">{c.ok} ok</Badge>
        {c.drift > 0 && <Badge tone="amber">{c.drift} drifted</Badge>}
        {c.error > 0 && <Badge tone="red">{c.error} {c.error === 1 ? 'error' : 'errors'}</Badge>}
        {c.noreturn > 0 && <Badge>{c.noreturn} no return</Badge>}
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
              <Link to={`/jobs/${r.jid}`} aria-label={text} title={text} className="-my-1 block py-1 hover:opacity-70">
                <span className={`block w-1.5 rounded-sm ${RUN_BAR[r.status]} ${r.status === 'failed' ? 'h-4' : 'h-3'}`} />
              </Link>
            </li>
          )
        })}
      </ul>
      <Link to={`/jobs?q=${encodeURIComponent(`schedule:${s.name}`)}${failed ? '&result=failed' : ''}`} className="text-zinc-500 hover:text-accent-600 dark:text-zinc-400">
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
            Compliance checks, patch scans or any function, run by the server on a schedule. Times are in the server's time zone ({meta.data?.timezone ?? '…'}). Results go to{' '}
            <Link to="/notifications" className="text-accent-700 hover:underline dark:text-accent-400">
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
                  <p className="mt-0.5 font-mono text-xs text-zinc-500 dark:text-zinc-400">
                    {s.kind === 'function' && `${s.fun} ${formatArgs([...(s.args?.arg ?? []), ...(s.args?.kwarg && Object.keys(s.args.kwarg).length ? [{ __kwarg__: true, ...s.args.kwarg }] : [])])} → `}
                    {s.targetType !== 'glob' && `${s.targetType}:`}
                    {s.target}
                  </p>
                </div>
                <div className="w-44 text-xs">
                  <p className="font-medium text-zinc-700 dark:text-zinc-300">{presetLabel(s.cron) ?? <span className="font-mono">{s.cron}</span>}</p>
                  <p className="text-zinc-500 dark:text-zinc-400">
                    {s.cronError ? <span className="text-red-600">{s.cronError}</span> : s.nextRunAt ? `next ${untilTime(new Date(s.nextRunAt))}` : 'paused'}
                  </p>
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
                      <Link to={`/jobs/${started[s.id]}`} className="text-accent-700 hover:underline dark:text-accent-400">
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
                        const { jid } = await api.runSchedule(s.id)
                        setStarted((m) => ({ ...m, [s.id]: jid }))
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
      ...(kind === 'function' ? { fun: fun.trim(), args: parseArgs(args) } : kind === 'osquery' ? { args: { sql: sql.trim() } } : {}),
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
        <TargetField
          tgt={tgt}
          tgtType={tgtType}
          onChange={(t, tt) => {
            setTgt(t)
            setTgtType(tt)
          }}
        />
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
