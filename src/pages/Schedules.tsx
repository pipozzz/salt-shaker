import { CalendarClock, ExternalLink, Pencil, Play, Plus, Trash2 } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { formatArgs, parseArgs } from '../api/salt'
import { automation, type Schedule, type ScheduleInput, type ScheduleKind } from '../api/server'
import type { TargetType } from '../api/types'
import { TargetField } from '../components/TargetField'
import { Badge, Button, Card, Empty, ErrorBox, Field, Input, Modal, PageHeader, Select, Spinner, Switch, type Tone } from '../components/ui'
import { useAsync } from '../lib/hooks'
import { relTime } from './Jobs'

const PRESETS: Array<[string, string]> = [
  ['0 * * * *', 'Every hour'],
  ['0 2 * * *', 'Every day at 02:00'],
  ['0 6 * * 1-5', 'Weekdays at 06:00'],
  ['0 6 * * 1', 'Mondays at 06:00'],
  ['0 3 1 * *', 'Monthly on the 1st at 03:00'],
]
const presetLabel = (cron: string) => PRESETS.find(([c]) => c === cron)?.[1]

const KIND_TONE: Record<ScheduleKind, Tone> = { compliance: 'accent', patches: 'blue', function: 'zinc' }
const KIND_LABEL: Record<ScheduleKind, string> = { compliance: 'Compliance', patches: 'Patch scan', function: 'Function' }

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
  if (!sum) return <span className="text-xs text-zinc-400">{s.lastRunAt ? 'collecting results…' : 'never ran'}</span>
  if (typeof sum.error === 'string') return <span className="text-xs text-red-600 dark:text-red-400">{sum.error}</span>
  if (s.kind === 'compliance') {
    const c = sum as { ok: number; drift: number; error: number; noreturn: number }
    return (
      <span className="flex flex-wrap gap-1">
        <Badge tone="green">{c.ok} ok</Badge>
        {c.drift > 0 && <Badge tone="amber">{c.drift} drifted</Badge>}
        {c.error > 0 && <Badge tone="red">{c.error} errors</Badge>}
        {c.noreturn > 0 && <Badge>{c.noreturn} no return</Badge>}
      </span>
    )
  }
  if (s.kind === 'patches') {
    const p = sum as { needUpdates: number; packages: number; scanned: number }
    return p.needUpdates ? <Badge tone="amber">{p.needUpdates} minions · {p.packages} packages</Badge> : <Badge tone="green">up to date</Badge>
  }
  const f = sum as { returned: number; failed: number }
  return f.failed ? <Badge tone="red">{f.failed} failed</Badge> : <Badge tone="green">{f.returned} ok</Badge>
}

export function SchedulesPage() {
  const list = useAsync(() => automation.schedules(), [])
  const meta = useAsync(() => automation.meta(), [])
  const [editing, setEditing] = useState<Schedule | 'new' | null>(null)
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
            <Link to="/notifications" className="text-accent-600 hover:underline dark:text-accent-400">
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
                <Switch checked={s.enabled} label={`Enable ${s.name}`} disabled={busy === `toggle:${s.id}`} onChange={(v) => act(`toggle:${s.id}`, () => automation.updateSchedule(s.id, { enabled: v }))} />
                <div className="min-w-48 flex-1">
                  <p className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{s.name}</span>
                    <Badge tone={KIND_TONE[s.kind]}>{KIND_LABEL[s.kind]}</Badge>
                  </p>
                  <p className="mt-0.5 font-mono text-xs text-zinc-500">
                    {s.kind === 'function' && `${s.fun} ${formatArgs([...(s.args?.arg ?? []), ...(s.args?.kwarg && Object.keys(s.args.kwarg).length ? [{ __kwarg__: true, ...s.args.kwarg }] : [])])} → `}
                    {s.targetType !== 'glob' && `${s.targetType}:`}
                    {s.target}
                  </p>
                </div>
                <div className="w-44 text-xs">
                  <p className="font-medium text-zinc-700 dark:text-zinc-300">{presetLabel(s.cron) ?? <span className="font-mono">{s.cron}</span>}</p>
                  <p className="text-zinc-500">
                    {s.cronError ? <span className="text-red-600">{s.cronError}</span> : s.nextRunAt ? `next ${untilTime(new Date(s.nextRunAt))}` : 'paused'}
                  </p>
                </div>
                <div className="w-52 space-y-1 text-xs">
                  <Summary s={s} />
                  {s.lastRunAt && (
                    <p className="text-zinc-500">
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
                      <Link to={`/jobs/${started[s.id]}`} className="text-accent-600 hover:underline dark:text-accent-400">
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
                        const { jid } = await automation.runSchedule(s.id)
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
              </li>
            ))}
          </ul>
        )}
      </Card>

      {editing && <ScheduleModal schedule={editing === 'new' ? null : editing} kinds={meta.data?.kinds} onClose={() => setEditing(null)} onSaved={list.reload} />}

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
              await act('delete', () => automation.deleteSchedule(removing!.id))
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

function ScheduleModal({ schedule, kinds, onClose, onSaved }: { schedule: Schedule | null; kinds?: Record<ScheduleKind, string>; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(schedule?.name ?? '')
  const [kind, setKind] = useState<ScheduleKind>(schedule?.kind ?? 'compliance')
  const [tgt, setTgt] = useState(schedule?.target ?? '*')
  const [tgtType, setTgtType] = useState<TargetType>((schedule?.targetType as TargetType) ?? 'glob')
  const [fun, setFun] = useState(schedule?.fun ?? '')
  const [args, setArgs] = useState(
    schedule?.args ? formatArgs([...(schedule.args.arg ?? []), ...(schedule.args.kwarg && Object.keys(schedule.args.kwarg).length ? [{ __kwarg__: true, ...schedule.args.kwarg }] : [])]) : '',
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
      ...(kind === 'function' ? { fun: fun.trim(), args: parseArgs(args) } : {}),
    }
    try {
      if (schedule) await automation.updateSchedule(schedule.id, input)
      else await automation.createSchedule(input)
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
          <Button type="submit" variant="primary" loading={busy}>
            {schedule ? 'Save' : 'Create schedule'}
          </Button>
        </div>
      </form>
    </Modal>
  )
}
