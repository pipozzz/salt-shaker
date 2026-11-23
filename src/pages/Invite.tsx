import { useState, type FormEvent } from 'react'
import { invitation } from '../api/server'
import { Badge, Button, ErrorBox, Field, Input, Spinner } from '../components/ui'
import { useAsync } from '../lib/hooks'
import { useSession } from '../lib/session'
import { Shell } from './Login'

/** Where an invitation link leads: the invited person sets their own password and is signed in. */
export function InvitePage({ token, onDone }: { token: string; onDone: () => void }) {
  const { login } = useSession()
  const invite = useAsync(() => invitation.get(token), [token])
  const [name, setName] = useState<string | null>(null)
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState<Error | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (password !== confirm) return setError(new Error('Passwords do not match'))
    setBusy(true)
    setError(null)
    try {
      const { username } = await invitation.accept(token, password, (name ?? invite.data?.name ?? '').trim())
      // signing in replaces whoever was signed in on this browser
      await login({ mode: 'server', apiUrl: '', username, password, eauth: '' })
      onDone()
    } catch (err) {
      setError(err as Error)
      setBusy(false)
    }
  }

  const box = 'space-y-4 rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-900'
  if (invite.loading && !invite.data) return <Shell><div className={box}><Spinner /></div></Shell>
  if (!invite.data)
    return (
      <Shell>
        <div className={box}>
          <h2 className="font-semibold">This invitation can't be used</h2>
          <p className="text-sm text-zinc-600 dark:text-zinc-400">{invite.error?.message ?? 'The link is not valid any more.'}</p>
          <Button className="w-full" onClick={onDone}>
            Go to sign-in
          </Button>
        </div>
      </Shell>
    )
  const i = invite.data
  return (
    <Shell>
      <form onSubmit={submit} className={box}>
        <div>
          <h2 className="font-semibold">You're invited</h2>
          <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
            Set a password to create your account. You'll sign in as <span className="font-mono font-medium text-zinc-900 dark:text-zinc-100">{i.username}</span> <Badge>{i.role}</Badge>
          </p>
        </div>
        {/* lets password managers save the right username */}
        <input type="text" name="username" value={i.username} autoComplete="username" readOnly hidden />
        <Field label="Full name (optional)">
          <Input value={name ?? i.name ?? ''} onChange={(e) => setName(e.target.value)} autoComplete="name" maxLength={100} />
        </Field>
        <Field label="Password" hint="At least 10 characters.">
          <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" minLength={10} maxLength={128} required autoFocus />
        </Field>
        <Field label="Repeat password">
          <Input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" required />
        </Field>
        {error && <ErrorBox error={error} />}
        <Button type="submit" variant="primary" className="w-full" loading={busy}>
          Create account and sign in
        </Button>
        <p className="text-center text-xs text-zinc-500 dark:text-zinc-400">This link works once, until {new Date(i.expiresAt).toLocaleString()}.</p>
      </form>
    </Shell>
  )
}
