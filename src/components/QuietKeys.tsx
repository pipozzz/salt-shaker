import { Moon, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { demoMinionsSeen } from '../api/demo-seen'
import { minionsSeen } from '../api/server'
import { relTime } from '../lib/format'
import { useAsync, useStoredState } from '../lib/hooks'
import { quietMinions } from '../lib/quiet'
import { useSalt, useSession } from '../lib/session'
import { Badge, Button, Card, CardHeader, ErrorBox, Modal, Select } from './ui'

const DAYS = [7, 30, 90, 180]
/**
 * Keys of minions that have been quiet for long: usually machines that were decommissioned while
 * their key stayed accepted, and are still counted, targeted and scanned. For whoever can delete keys.
 */
export function QuietKeys({ accepted, onDeleted }: { accepted: string[]; onDeleted: () => void }) {
  const salt = useSalt()
  const { session } = useSession()
  const source = session?.mode === 'demo' ? demoMinionsSeen : session?.mode === 'server' ? minionsSeen : null
  const [days, setDays] = useStoredState('keys.quietDays', 30)
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<Error | null>(null)
  const data = useAsync(async () => {
    if (!source) return null
    const [seen, status] = await Promise.all([source(), salt.status()])
    return { seen, down: status.down }
  }, [source, salt])
  if (!source || !data.data) return null
  const { seen, down } = data.data
  if (!seen.checking && !seen.since) return null
  const quiet = quietMinions(accepted, down, seen, days)

  const remove = async () => {
    setBusy(true)
    setError(null)
    try {
      for (const q of quiet) await salt.deleteKey(q.id)
      setConfirm(false)
      onDeleted()
      await data.reload()
    } catch (e) {
      setError(e as Error)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card>
      <CardHeader
        title={`Quiet for a while (${quiet.length})`}
        subtitle="Accepted minions that don't answer now and haven't for long: often machines that are gone, but whose keys are still counted, targeted and scanned."
        actions={
          <div className="flex items-center gap-2">
            <Select value={days} onChange={(e) => setDays(Number(e.target.value))} aria-label="Quiet for at least">
              {DAYS.map((d) => (
                <option key={d} value={d}>
                  {d}+ days
                </option>
              ))}
            </Select>
            {quiet.length > 0 && (
              <Button variant="danger" size="sm" icon={<Trash2 className="size-4" />} onClick={() => setConfirm(true)}>
                Delete {quiet.length === 1 ? 'key' : `${quiet.length} keys`}
              </Button>
            )}
          </div>
        }
      />
      {quiet.length === 0 ? (
        <p className="flex items-center gap-2 p-4 text-sm text-zinc-500 dark:text-zinc-400">
          <Moon className="size-4" /> Every accepted minion answered within the last {days} days.
        </p>
      ) : (
        <ul className="divide-y divide-zinc-100 text-sm dark:divide-zinc-800/70">
          {quiet.map((q) => (
            <li key={q.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2.5">
              <span className="font-mono font-medium">{q.id}</span>
              <Badge tone="red">down</Badge>
              <span className="text-xs text-zinc-600 dark:text-zinc-400">
                {q.lastSeen ? `last answered ${relTime(new Date(q.lastSeen))}` : `hasn't answered since ${new Date(seen.since!).toLocaleDateString()}`}
              </span>
            </li>
          ))}
        </ul>
      )}
      {!seen.checking && <p className="px-4 pb-3 text-xs text-zinc-500 dark:text-zinc-400">Presence checks are off (PRESENCE_CHECK_MINUTES=0), so these dates stopped moving.</p>}

      <Modal open={confirm} onClose={() => setConfirm(false)} title={quiet.length === 1 ? 'Delete 1 key?' : `Delete ${quiet.length} keys?`}>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">These keys will be removed from the master. A minion that is in fact still around will ask again and wait in Pending.</p>
        <p className="mt-3 font-mono text-sm break-words">{quiet.map((q) => q.id).join(', ')}</p>
        {error && (
          <div className="mt-3">
            <ErrorBox error={error} />
          </div>
        )}
        <div className="mt-5 flex justify-end gap-2">
          <Button onClick={() => setConfirm(false)}>Cancel</Button>
          <Button variant="danger" icon={<Trash2 className="size-4" />} loading={busy} onClick={remove}>
            Delete {quiet.length === 1 ? 'key' : `${quiet.length} keys`}
          </Button>
        </div>
      </Modal>
    </Card>
  )
}
