import { useState, type FormEvent } from 'react'
import { changeOwnPassword } from '../api/server'
import { useSession } from '../lib/session'
import { Badge, Button, ErrorBox, Field, Input, Modal } from './ui'

/** Server mode: who you are, your role, and changing your own password. */
export function AccountModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { session } = useSession()
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState<Error | null>(null)
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(false)

  const close = () => {
    setCurrent('')
    setNext('')
    setConfirm('')
    setError(null)
    setDone(false)
    onClose()
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (next !== confirm) return setError(new Error('New passwords do not match'))
    setBusy(true)
    setError(null)
    try {
      await changeOwnPassword(current, next)
      setDone(true)
    } catch (err) {
      setError(err as Error)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal open={open} onClose={close} title="Your account">
      <div className="mb-5 flex items-center gap-2 text-sm">
        <span className="font-mono font-medium">{session?.user}</span>
        <Badge tone="accent">{session?.eauth}</Badge>
      </div>
      {done ? (
        <div className="space-y-4 text-sm">
          <p>Password changed. Your other sessions were signed out.</p>
          <div className="flex justify-end">
            <Button onClick={close}>Close</Button>
          </div>
        </div>
      ) : (
        <form onSubmit={submit} className="space-y-4">
          <Field label="Current password">
            <Input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" required />
          </Field>
          <Field label="New password" hint="At least 10 characters.">
            <Input type="password" value={next} onChange={(e) => setNext(e.target.value)} minLength={10} autoComplete="new-password" required />
          </Field>
          <Field label="Repeat new password">
            <Input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" required />
          </Field>
          {error && <ErrorBox error={error} />}
          <div className="flex justify-end gap-2">
            <Button type="button" onClick={close}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" loading={busy}>
              Change password
            </Button>
          </div>
        </form>
      )}
    </Modal>
  )
}
