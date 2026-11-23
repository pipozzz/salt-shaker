import { Check, Copy, Fingerprint, KeyRound, Plus, ShieldCheck, Trash2 } from 'lucide-react'
import qrcode from 'qrcode-generator'
import { useMemo, useState, type FormEvent } from 'react'
import { currentUser, passkeys, twoFactor, type Passkey } from '../api/server'
import { Badge, Button, Card, CardHeader, Empty, ErrorBox, Field, Input, Modal, PageHeader, Spinner } from '../components/ui'
import { relTime } from '../lib/format'
import { useAsync } from '../lib/hooks'
import { useSession } from '../lib/session'

/**
 * The authenticator entry, labelled with the username and this site instead of the made-up email
 * local accounts have: that label is what people see in their app, next to every other code.
 */
function totpUriFor(uri: string, username: string, host: string) {
  const u = new URL(uri)
  const issuer = u.searchParams.get('issuer') ?? 'Salt Shaker'
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(`${username}@${host}`)}?${u.searchParams}`
}

/** Your own sign-in: a second step from an authenticator app, and passkeys. */
export function SecurityPage() {
  const { session } = useSession()
  const me = useAsync(() => currentUser(), [])
  const signIn = me.data?.signIn
  return (
    <>
      <PageHeader title="Sign-in security" description="How you prove it's you: a second step after your password, and passkeys that replace the password altogether." />
      {me.loading && !me.data && <Spinner />}
      {me.error && <ErrorBox error={me.error} onRetry={me.reload} />}
      {signIn && (
        <div className="space-y-6">
          <TwoStep on={signIn.twoFactor} hasPassword={signIn.password} username={session?.user ?? ''} onChange={me.reload} />
          <Passkeys />
        </div>
      )}
    </>
  )
}

function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <Button
      size="sm"
      icon={copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
      onClick={() =>
        void navigator.clipboard
          .writeText(text)
          .then(() => setCopied(true))
          .catch(() => undefined)
      }
    >
      {copied ? 'Copied' : label}
    </Button>
  )
}

/** The otpauth:// link as a QR code, drawn here: the secret never leaves the page. */
function QrCode({ text }: { text: string }) {
  const cells = useMemo(() => {
    const qr = qrcode(0, 'M')
    qr.addData(text)
    qr.make()
    const n = qr.getModuleCount()
    let d = ''
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c} ${r}h1v1h-1z`
    return { n, d }
  }, [text])
  const q = 3 // quiet zone
  return (
    <svg viewBox={`${-q} ${-q} ${cells.n + 2 * q} ${cells.n + 2 * q}`} className="size-44 shrink-0 rounded-lg bg-white" role="img" aria-label="QR code for your authenticator app" shapeRendering="crispEdges">
      <path d={cells.d} fill="#000" />
    </svg>
  )
}

function BackupCodes({ codes }: { codes: string[] }) {
  return (
    <div className="space-y-3">
      <p className="text-sm text-zinc-600 dark:text-zinc-400">
        Keep these backup codes somewhere safe, away from your phone. Each one signs you in once when you can't get a code from the app. They aren't shown again.
      </p>
      <pre className="grid grid-cols-2 gap-x-6 gap-y-1 rounded-lg bg-zinc-100 p-3 font-mono text-sm select-all dark:bg-zinc-800" aria-label="Backup codes">
        {codes.map((c) => (
          <span key={c}>{c}</span>
        ))}
      </pre>
      <CopyButton text={codes.join('\n')} label="Copy all" />
    </div>
  )
}

type Step = { kind: 'password'; then: 'enable' | 'disable' | 'codes' } | { kind: 'scan'; uri: string; codes: string[] } | { kind: 'codes'; codes: string[]; title: string }

function TwoStep({ on, hasPassword, username, onChange }: { on: boolean; hasPassword: boolean; username: string; onChange: () => void }) {
  const [step, setStep] = useState<Step | null>(null)
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const [error, setError] = useState<Error | null>(null)
  const [busy, setBusy] = useState(false)

  const close = () => {
    setStep(null)
    setPassword('')
    setCode('')
    setError(null)
    onChange()
  }
  const run = async (fn: () => Promise<void>) => {
    setBusy(true)
    setError(null)
    try {
      await fn()
    } catch (e) {
      setError(e as Error)
    } finally {
      setBusy(false)
    }
  }

  const withPassword = (e: FormEvent) => {
    e.preventDefault()
    if (step?.kind !== 'password') return
    const then = step.then
    void run(async () => {
      if (then === 'enable') {
        const made = await twoFactor.enable(password)
        setStep({ kind: 'scan', uri: totpUriFor(made.totpURI, username, window.location.host), codes: made.backupCodes })
      } else if (then === 'codes') {
        setStep({ kind: 'codes', codes: (await twoFactor.newBackupCodes(password)).backupCodes, title: 'New backup codes' })
      } else {
        await twoFactor.disable(password)
        close()
      }
      setPassword('')
    })
  }
  const confirm = (e: FormEvent) => {
    e.preventDefault()
    if (step?.kind !== 'scan') return
    const codes = step.codes
    void run(async () => {
      await twoFactor.confirm(code.replace(/\s/g, ''))
      setCode('')
      setStep({ kind: 'codes', codes, title: 'Two-step verification is on' })
    })
  }

  const secret = step?.kind === 'scan' ? (new URL(step.uri).searchParams.get('secret') ?? '') : ''
  return (
    <Card>
      <CardHeader
        title={
          <span className="flex items-center gap-2">
            <ShieldCheck className="size-4" /> Two-step verification {on ? <Badge tone="green">on</Badge> : <Badge>off</Badge>}
          </span>
        }
        subtitle="After your password, a 6-digit code from an authenticator app (Aegis, 1Password, Google Authenticator, …)."
        actions={
          !hasPassword ? null : on ? (
            <>
              <Button size="sm" onClick={() => setStep({ kind: 'password', then: 'codes' })}>
                New backup codes
              </Button>
              <Button size="sm" variant="danger" onClick={() => setStep({ kind: 'password', then: 'disable' })}>
                Turn off
              </Button>
            </>
          ) : (
            <Button size="sm" variant="primary" onClick={() => setStep({ kind: 'password', then: 'enable' })}>
              Set up
            </Button>
          )
        }
      />
      <p className="px-4 py-3 text-sm text-zinc-600 dark:text-zinc-400">
        {!hasPassword
          ? "Your account signs in through single sign-on and has no password here, so the second step is your identity provider's to ask for."
          : on
            ? 'You are asked for a code whenever you sign in with your password. A passkey sign-in needs no code: the passkey already is two factors.'
            : 'Off: your password alone signs you in.'}
      </p>

      <Modal
        open={!!step}
        onClose={close}
        title={step?.kind === 'codes' ? step.title : step?.kind === 'scan' ? 'Add Salt Shaker to your authenticator app' : step?.then === 'disable' ? 'Turn off two-step verification?' : 'Confirm your password'}
      >
        {step?.kind === 'password' && (
          <form onSubmit={withPassword} className="space-y-4">
            {step.then === 'disable' && <p className="text-sm text-zinc-600 dark:text-zinc-400">Your password alone will sign you in again, and your backup codes stop working.</p>}
            {step.then === 'codes' && <p className="text-sm text-zinc-600 dark:text-zinc-400">The backup codes you have now stop working.</p>}
            <Field label="Your password">
              <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required autoFocus />
            </Field>
            {error && <ErrorBox error={error} />}
            <div className="flex justify-end gap-2">
              <Button type="button" onClick={close}>
                Cancel
              </Button>
              <Button type="submit" variant={step.then === 'disable' ? 'danger' : 'primary'} loading={busy}>
                {step.then === 'disable' ? 'Turn off' : 'Continue'}
              </Button>
            </div>
          </form>
        )}
        {step?.kind === 'scan' && (
          <form onSubmit={confirm} className="space-y-4">
            <div className="flex flex-wrap items-start gap-4">
              <QrCode text={step.uri} />
              <div className="min-w-48 flex-1 space-y-3 text-sm">
                <p className="text-zinc-600 dark:text-zinc-400">Scan this with your authenticator app, or type the key in by hand:</p>
                <code className="block rounded-lg bg-zinc-100 px-3 py-2 font-mono text-xs break-all select-all dark:bg-zinc-800" aria-label="Setup key">
                  {secret}
                </code>
                <CopyButton text={secret} label="Copy key" />
              </div>
            </div>
            <Field label="Code from the app" hint="Nothing changes until a code from the app is confirmed here.">
              <Input value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" autoComplete="one-time-code" pattern="[0-9 ]{6,7}" placeholder="123456" className="font-mono" required autoFocus />
            </Field>
            {error && <ErrorBox error={error} />}
            <div className="flex justify-end gap-2">
              <Button type="button" onClick={close}>
                Cancel
              </Button>
              <Button type="submit" variant="primary" loading={busy}>
                Turn on
              </Button>
            </div>
          </form>
        )}
        {step?.kind === 'codes' && (
          <div className="space-y-4">
            <BackupCodes codes={step.codes} />
            <div className="flex justify-end">
              <Button variant="primary" onClick={close}>
                I saved them
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </Card>
  )
}

function Passkeys() {
  const list = useAsync(() => passkeys.list(), [])
  const [name, setName] = useState('')
  const [error, setError] = useState<Error | null>(null)
  const [busy, setBusy] = useState(false)
  const [removing, setRemoving] = useState<Passkey | null>(null)
  const supported = passkeys.supported()

  const add = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await passkeys.add(name.trim())
      setName('')
      list.reload()
    } catch (err) {
      setError(err as Error)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card>
      <CardHeader
        title={
          <span className="flex items-center gap-2">
            <Fingerprint className="size-4" /> Passkeys
          </span>
        }
        subtitle="Sign in with your fingerprint, face, device PIN or a security key instead of the password. Nothing to phish, nothing to type."
      />
      {supported ? (
        <form onSubmit={add} className="flex flex-wrap items-end gap-3 border-b border-zinc-200 p-4 dark:border-zinc-800">
          <Field label="Name">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Work laptop" className="w-64" maxLength={60} required aria-label="Passkey name" />
          </Field>
          <Button type="submit" variant="primary" icon={<Plus className="size-4" />} loading={busy} disabled={!name.trim()}>
            Add a passkey
          </Button>
        </form>
      ) : (
        <p className="border-b border-zinc-200 px-4 py-3 text-sm text-zinc-600 dark:border-zinc-800 dark:text-zinc-400">This browser can't use passkeys (they need HTTPS, or localhost).</p>
      )}
      {error && (
        <div className="px-4 pt-4">
          <ErrorBox error={error} />
        </div>
      )}
      {list.error && (
        <div className="p-4">
          <ErrorBox error={list.error} onRetry={list.reload} />
        </div>
      )}
      {list.loading && !list.data ? (
        <Spinner />
      ) : !list.data?.length ? (
        <Empty icon={<KeyRound />} title="No passkeys yet" />
      ) : (
        <ul className="divide-y divide-zinc-100 dark:divide-zinc-800/70">
          {list.data.map((p) => (
            <li key={p.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 text-sm">
              <div className="min-w-48 flex-1">
                <p className="font-medium">{p.name || 'Passkey'}</p>
                <p className="text-xs text-zinc-500 dark:text-zinc-400">
                  {p.backedUp ? 'synced by its password manager' : 'kept on one device'}
                  {p.createdAt ? ` · added ${relTime(new Date(p.createdAt))}` : ''}
                </p>
              </div>
              <Button size="sm" variant="ghost" icon={<Trash2 className="size-3.5" />} onClick={() => setRemoving(p)}>
                Remove
              </Button>
            </li>
          ))}
        </ul>
      )}
      <Modal open={!!removing} onClose={() => setRemoving(null)} title="Remove this passkey?">
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          <strong>{removing?.name || 'This passkey'}</strong> can't sign you in any more. Delete it from your device or password manager too, so it isn't offered again.
        </p>
        <div className="mt-5 flex justify-end gap-2">
          <Button onClick={() => setRemoving(null)}>Cancel</Button>
          <Button
            variant="danger"
            onClick={async () => {
              await passkeys.remove(removing!.id).catch((e: Error) => setError(e))
              setRemoving(null)
              list.reload()
            }}
          >
            Remove
          </Button>
        </div>
      </Modal>
    </Card>
  )
}
