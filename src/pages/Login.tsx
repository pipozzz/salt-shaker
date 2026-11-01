import clsx from 'clsx'
import { FlaskConical, PlugZap } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { Logo } from '../components/Logo'
import { Button, ErrorBox, Field, Input, Select } from '../components/ui'
import { useStoredState } from '../lib/hooks'
import { DEFAULT_API_URL, useSession, type Mode } from '../lib/session'

export function LoginPage() {
  const { login } = useSession()
  const [mode, setMode] = useStoredState<Mode>('salt-shaker.login.mode', 'live')
  const [apiUrl, setApiUrl] = useStoredState('salt-shaker.login.api', DEFAULT_API_URL)
  const [username, setUsername] = useStoredState('salt-shaker.login.user', '')
  const [eauth, setEauth] = useStoredState('salt-shaker.login.eauth', 'pam')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<Error | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await login({ mode, apiUrl, username: mode === 'demo' ? username || 'demo' : username, password, eauth })
    } catch (err) {
      setError(err as Error)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden px-4 py-12">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_50%_0%,rgb(20_184_166/0.12),transparent_60%)]" />
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(rgb(113_113_122/0.18)_1px,transparent_1px)] [background-size:20px_20px] [mask-image:radial-gradient(ellipse_at_center,black_30%,transparent_75%)]" />
      <div className="relative w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center text-center">
          <Logo className="size-12 drop-shadow-sm" />
          <h1 className="mt-4 text-2xl font-semibold tracking-tight">Salt Shaker</h1>
          <p className="mt-1 text-sm text-zinc-500">A friendly console for your SaltStack master</p>
        </div>

        <form onSubmit={submit} className="space-y-4 rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
          <div className="grid grid-cols-2 gap-1 rounded-lg bg-zinc-100 p-1 dark:bg-zinc-800/70">
            {(
              [
                ['live', 'salt-api', PlugZap],
                ['demo', 'Demo', FlaskConical],
              ] as const
            ).map(([m, label, Icon]) => (
              <button
                type="button"
                key={m}
                onClick={() => setMode(m)}
                className={clsx(
                  'flex items-center justify-center gap-1.5 rounded-md py-1.5 text-sm font-medium transition',
                  mode === m ? 'bg-white shadow-xs dark:bg-zinc-950' : 'text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200',
                )}
              >
                <Icon className="size-3.5" /> {label}
              </button>
            ))}
          </div>

          {mode === 'live' ? (
            <>
              <Field label="salt-api URL" hint="Use /salt-api for the dev proxy, or the full https:// URL of rest_cherrypy.">
                <Input value={apiUrl} onChange={(e) => setApiUrl(e.target.value)} placeholder="https://salt-master:8000" required />
              </Field>
              <div className="grid grid-cols-[1fr_auto] gap-3">
                <Field label="Username">
                  <Input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" required autoFocus />
                </Field>
                <Field label="eauth">
                  <Select value={eauth} onChange={(e) => setEauth(e.target.value)} className="w-32">
                    <option value="pam">pam</option>
                    <option value="ldap">ldap</option>
                    <option value="sharedsecret">sharedsecret</option>
                    <option value="file">file</option>
                    <option value="auto">auto</option>
                  </Select>
                </Field>
              </div>
              <Field label="Password">
                <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
              </Field>
            </>
          ) : (
            <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-800 dark:bg-amber-500/10 dark:text-amber-300">
              Explore the UI against a simulated master with six minions, pending keys and job history. Nothing leaves your browser.
            </p>
          )}

          {error && <ErrorBox error={error} />}

          <Button type="submit" variant="primary" className="w-full" loading={busy}>
            {mode === 'demo' ? 'Open demo' : 'Sign in'}
          </Button>
        </form>
      </div>
    </div>
  )
}
