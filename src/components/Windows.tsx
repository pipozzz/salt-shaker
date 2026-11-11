import clsx from 'clsx'
import { CalendarClock, Trash2 } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { useAsync } from '../lib/hooks'
import { useMaintenanceApi } from '../lib/maintenance'
import { DAY_NAMES, describeWindow } from '../lib/windows'
import { Button, Card, CardHeader, ErrorBox, Field, Input, Select } from './ui'

const WEEK = [1, 2, 3, 4, 5, 6, 0]
const LENGTHS = [30, 60, 120, 180, 240, 360, 480, 720, 1440]
const lengthLabel = (m: number) => (m < 60 ? `${m} minutes` : m === 60 ? '1 hour' : `${m / 60} hours`)
const when = (iso: string) => new Date(iso).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })

/** On System: the maintenance windows, and a form to add one (admins). */
export function MaintenanceWindows() {
  const api = useMaintenanceApi()
  const [reloads, setReloads] = useState(0)
  const list = useAsync(() => (api ? api.list() : Promise.resolve(null)), [api, reloads])
  const [name, setName] = useState('')
  const [days, setDays] = useState<number[]>([2, 4])
  const [start, setStart] = useState('22:00')
  const [minutes, setMinutes] = useState(240)
  const [timezone, setTimezone] = useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<Error | null>(null)
  if (!api) return null

  const add = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await api.add({ name, days, start, minutes, timezone })
      setName('')
      setReloads((n) => n + 1)
    } catch (err) {
      setError(err as Error)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card className="lg:col-span-2">
      <CardHeader
        title="Maintenance windows"
        subtitle="When changes are expected. A schedule tied to a window waits for it to open; Run and Changes say when you're outside every window."
      />
      {list.data && list.data.windows.length > 0 && (
        <ul className="divide-y divide-zinc-100 border-b border-zinc-100 text-sm dark:divide-zinc-800/70 dark:border-zinc-800">
          {list.data.windows.map((w) => (
            <li key={w.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5">
              <span className="font-medium">{w.name}</span>
              <span className="text-zinc-600 dark:text-zinc-400">{describeWindow(w)}</span>
              {list.data!.open?.id === w.id && <span className="text-xs font-medium text-emerald-700 dark:text-emerald-400">open until {when(list.data!.open.end)}</span>}
              <Button
                size="sm"
                variant="ghost"
                className="ml-auto"
                icon={<Trash2 className="size-3.5" />}
                aria-label={`Remove ${w.name}`}
                onClick={async () => {
                  await api.remove(w.id)
                  setReloads((n) => n + 1)
                }}
              />
            </li>
          ))}
        </ul>
      )}
      <form onSubmit={add} className="flex flex-wrap items-end gap-3 p-4">
        <Field label="Name">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Patch nights" className="w-36" required aria-label="Window name" />
        </Field>
        <fieldset>
          <legend className="mb-1 text-xs font-medium text-zinc-700 dark:text-zinc-300">Days</legend>
          <div className="flex gap-1">
            {WEEK.map((d) => {
              const on = days.includes(d)
              return (
                <button
                  key={d}
                  type="button"
                  aria-pressed={on}
                  onClick={() => setDays(on ? days.filter((x) => x !== d) : [...days, d])}
                  className={clsx(
                    'h-9 w-10 rounded-md border text-xs font-medium',
                    on ? 'border-zinc-900 bg-zinc-900 text-white dark:border-zinc-100 dark:bg-zinc-100 dark:text-zinc-900' : 'border-zinc-300 bg-white text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300',
                  )}
                >
                  {DAY_NAMES[d]}
                </button>
              )
            })}
          </div>
        </fieldset>
        <Field label="Opens at">
          <Input type="time" value={start} onChange={(e) => setStart(e.target.value)} className="w-28" required aria-label="Opens at" />
        </Field>
        <Field label="For">
          <Select value={minutes} onChange={(e) => setMinutes(Number(e.target.value))} aria-label="Window length">
            {LENGTHS.map((m) => (
              <option key={m} value={m}>
                {lengthLabel(m)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Timezone">
          <Input value={timezone} onChange={(e) => setTimezone(e.target.value)} className="w-44" required aria-label="Timezone" />
        </Field>
        <Button type="submit" variant="primary" loading={busy} disabled={!name.trim() || !days.length}>
          Add
        </Button>
      </form>
      {error && (
        <div className="px-4 pb-4">
          <ErrorBox error={error} />
        </div>
      )}
    </Card>
  )
}

/** On Run and Changes: a line saying you're in a window, or outside them all and when the next opens. */
export function WindowNotice({ className }: { className?: string }) {
  const api = useMaintenanceApi()
  const state = useAsync(() => (api ? api.list() : Promise.resolve(null)), [api])
  const s = state.data
  if (!s || !s.windows.length) return null
  const name = (id: number) => s.windows.find((w) => w.id === id)?.name ?? 'a window'
  const inside = !!s.open
  return (
    <p
      role="status"
      className={clsx(
        'flex items-center gap-2 rounded-lg border px-3 py-2 text-sm',
        inside ? 'border-emerald-200 bg-emerald-50 text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200' : 'border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200',
        className,
      )}
    >
      <CalendarClock className="size-4 shrink-0" aria-hidden />
      {s.open ? (
        <span>
          Inside the maintenance window <strong>{name(s.open.id)}</strong> until {when(s.open.end)}.
        </span>
      ) : (
        <span>
          Outside every maintenance window.{s.next && <> The next is <strong>{name(s.next.id)}</strong>, {when(s.next.start)}.</>}
        </span>
      )}
    </p>
  )
}
