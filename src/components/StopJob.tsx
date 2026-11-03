import { useState } from 'react'
import { formatArgs } from '../api/salt'
import { useSalt } from '../lib/session'
import { Button, ErrorBox, Modal } from './ui'

/** Confirms and kills a job on the minions still running it (saltutil.kill_job). */
export function StopJobModal({ job, onClose, onStopped }: { job: { jid: string; fun: string; args: unknown[]; minions: string[] } | null; onClose: () => void; onStopped: () => unknown }) {
  const salt = useSalt()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<Error | null>(null)

  const close = () => {
    setError(null)
    onClose()
  }
  const stop = async () => {
    if (!job) return
    setBusy(true)
    setError(null)
    try {
      await salt.killJob(job.jid, job.minions)
      onClose()
      await onStopped()
    } catch (e) {
      setError(e instanceof Error ? e : new Error(String(e)))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal open={!!job} onClose={close} title="Stop job">
      {job && (
        <div className="space-y-4 text-sm">
          <p>
            Kill <code className="rounded bg-zinc-100 px-1 font-mono dark:bg-zinc-800">{`${job.fun} ${formatArgs(job.args)}`.trim()}</code> on{' '}
            <strong>
              {job.minions.length} {job.minions.length === 1 ? 'minion' : 'minions'}
            </strong>{' '}
            (<span className="font-mono">{job.minions.join(', ')}</span>)?
          </p>
          <p className="text-zinc-600 dark:text-zinc-400">
            Each minion gets <code className="font-mono">saltutil.kill_job</code>, which ends the job's process at once. Those minions won't return a result, and a state run stopped
            midway may leave some states applied and others not.
          </p>
          {error && <ErrorBox error={error} />}
          <div className="flex justify-end gap-2">
            <Button onClick={close}>Cancel</Button>
            <Button variant="danger" loading={busy} onClick={stop}>
              Stop on {job.minions.length}
            </Button>
          </div>
        </div>
      )}
    </Modal>
  )
}
