import { DoorOpen, TriangleAlert } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { demoKeyRules } from '../api/demo-keyrules'
import { keyRules as serverKeyRules, type KeyRule } from '../api/server'
import { relTime } from '../lib/format'
import { useAsync } from '../lib/hooks'
import { useSession } from '../lib/session'
import { Badge, Button, Card, CardHeader, ErrorBox, Field, Input, Select } from './ui'

const HOURS = [1, 2, 4, 8, 24, 72]
/** still accepting: not expired, and not full */
const isOpen = (r: KeyRule) => Date.parse(r.expiresAt) > Date.now() && r.accepted.length < r.maxAccepts

/** "Accept new minions named web-2026-* for the next 2 hours, at most 10": for admins, with the server. */
export function EnrollmentWindows({ onAccepted }: { onAccepted: () => void }) {
  const { session } = useSession()
  const api = session?.mode === 'demo' ? demoKeyRules : session?.mode === 'server' && session.eauth === 'admin' ? serverKeyRules : null
  const [reloads, setReloads] = useState(0)
  const list = useAsync(() => (api ? api.list() : Promise.resolve(null)), [api, reloads])
  const [pattern, setPattern] = useState('')
  const [hours, setHours] = useState(2)
  const [max, setMax] = useState(10)
  const [error, setError] = useState<Error | null>(null)
  const [busy, setBusy] = useState(false)
  if (!api) return null

  const open = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await api.open(pattern.trim(), hours, max)
      setPattern('')
      setReloads((n) => n + 1)
      onAccepted()
    } catch (err) {
      setError(err as Error)
    } finally {
      setBusy(false)
    }
  }
  const rules = list.data?.rules ?? []

  return (
    <Card>
      <CardHeader title="Enrollment windows" subtitle="While you bring up new servers: their keys are accepted as they arrive, for a while and up to a number." />
      <form onSubmit={open} className="flex flex-wrap items-end gap-3 p-4">
        <Field label="Minion ids like">
          <Input value={pattern} onChange={(e) => setPattern(e.target.value)} placeholder="web-2026-*" className="w-56 font-mono" required aria-label="Minion ids like" />
        </Field>
        <Field label="For">
          <Select value={hours} onChange={(e) => setHours(Number(e.target.value))} aria-label="Window length">
            {HOURS.map((h) => (
              <option key={h} value={h}>
                {h === 1 ? '1 hour' : `${h} hours`}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="At most">
          <Input type="number" min={1} max={500} value={max} onChange={(e) => setMax(Math.max(1, Number(e.target.value) || 1))} className="w-24" aria-label="At most" />
        </Field>
        <Button type="submit" icon={<DoorOpen className="size-4" />} loading={busy} disabled={!pattern.trim()}>
          Open a window
        </Button>
      </form>
      <p className="flex items-start gap-1.5 px-4 pb-3 text-xs text-amber-700 dark:text-amber-400">
        <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
        Any machine that reaches the master can ask for any id, and no one checks its fingerprint: open a window only on a network you trust, for as short as you can.
      </p>
      {error && (
        <div className="px-4 pb-3">
          <ErrorBox error={error} />
        </div>
      )}
      {rules.length > 0 && (
        <ul className="divide-y divide-zinc-100 border-t border-zinc-100 text-sm dark:divide-zinc-800/70 dark:border-zinc-800">
          {rules.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2.5">
              <span className="font-mono font-medium">{r.pattern}</span>
              {isOpen(r) ? <Badge tone="amber">open until {new Date(r.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</Badge> : <Badge>closed</Badge>}
              <span className="text-xs text-zinc-600 dark:text-zinc-400">
                accepted {r.accepted.length} of {r.maxAccepts}
                {r.accepted.length > 0 && <span className="font-mono">: {r.accepted.join(', ')}</span>}
              </span>
              <span className="ml-auto text-xs text-zinc-500 dark:text-zinc-400">
                {r.createdBy ?? 'someone'}, {relTime(new Date(r.createdAt))}
              </span>
              {isOpen(r) && (
                <Button
                  size="sm"
                  onClick={async () => {
                    await api.close(r.id)
                    setReloads((n) => n + 1)
                  }}
                >
                  Close
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}
