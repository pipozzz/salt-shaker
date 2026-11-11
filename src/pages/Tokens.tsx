import { SlackLinks } from '../components/SlackLinks'
import { Check, Copy, KeySquare, Plus, Trash2 } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { demoTokens } from '../api/demo-tokens'
import { tokens as serverTokens, type ApiToken } from '../api/server'
import { Badge, Button, Card, CardHeader, Empty, ErrorBox, Field, Input, Modal, PageHeader, Select, Spinner } from '../components/ui'
import { relTime } from '../lib/format'
import { useAsync } from '../lib/hooks'
import { useSession } from '../lib/session'

/** checked when listing, outside render's purity rules */
const isExpired = (t: ApiToken) => !!t.expiresAt && Date.parse(t.expiresAt) < Date.now()

const EXPIRY = [
  { days: 30, label: '30 days' },
  { days: 90, label: '90 days' },
  { days: 365, label: 'A year' },
  { days: 0, label: 'Never' },
]

/** Personal API tokens: scripts and CI act as you, with your role, limits and audit trail. */
export function TokensPage() {
  const { session } = useSession()
  const api = session?.mode === 'demo' ? demoTokens : serverTokens
  const list = useAsync(() => api.list(), [api])
  const [name, setName] = useState('')
  const [days, setDays] = useState(90)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<Error | null>(null)
  const [made, setMade] = useState<(ApiToken & { token: string }) | null>(null)
  const [revoking, setRevoking] = useState<ApiToken | null>(null)

  const create = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      setMade(await api.create(name.trim(), days || null))
      setName('')
      await list.reload()
    } catch (err) {
      setError(err as Error)
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <PageHeader
        title="API tokens"
        description="For scripts and CI: a token acts as you, with your role, your limits and approvals, and everything it does is in the audit log under your name."
      />
      <Card className="mb-6">
        <form onSubmit={create} className="flex flex-wrap items-end gap-3 p-4">
          <Field label="Name">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="gitlab: deploy pipeline" className="w-72" required aria-label="Token name" />
          </Field>
          <Field label="Expires">
            <Select value={days} onChange={(e) => setDays(Number(e.target.value))} aria-label="Expires">
              {EXPIRY.map((x) => (
                <option key={x.days} value={x.days}>
                  {x.label}
                </option>
              ))}
            </Select>
          </Field>
          <Button type="submit" variant="primary" icon={<Plus className="size-4" />} loading={busy} disabled={!name.trim()}>
            Make a token
          </Button>
        </form>
        {error && (
          <div className="px-4 pb-4">
            <ErrorBox error={error} />
          </div>
        )}
      </Card>

      <Card>
        <CardHeader title="Your tokens" />
        {list.loading && !list.data ? (
          <Spinner />
        ) : !list.data?.tokens.length ? (
          <Empty icon={<KeySquare />} title="No tokens yet" />
        ) : (
          <ul className="divide-y divide-zinc-100 dark:divide-zinc-800/70">
            {list.data.tokens.map((t) => {
              const expired = isExpired(t)
              return (
                <li key={t.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 text-sm">
                  <div className="min-w-48 flex-1">
                    <p className="font-medium">{t.name}</p>
                    <p className="font-mono text-xs text-zinc-500 dark:text-zinc-400">{t.prefix}…</p>
                  </div>
                  <span className="w-40 text-xs text-zinc-500 dark:text-zinc-400">{t.lastUsedAt ? `used ${relTime(new Date(t.lastUsedAt))}` : 'never used'}</span>
                  <span className="w-40 text-xs text-zinc-500 dark:text-zinc-400">
                    {expired ? <Badge tone="red">expired</Badge> : t.expiresAt ? `until ${new Date(t.expiresAt).toLocaleDateString()}` : 'never expires'}
                  </span>
                  <Button size="sm" variant="ghost" icon={<Trash2 className="size-3.5" />} onClick={() => setRevoking(t)}>
                    Revoke
                  </Button>
                </li>
              )
            })}
          </ul>
        )}
      </Card>

      {session?.mode === 'server' && <SlackLinks />}

      {made && <TokenShown token={made} onClose={() => setMade(null)} />}

      <Modal open={!!revoking} onClose={() => setRevoking(null)} title="Revoke this token?">
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          <strong>{revoking?.name}</strong> stops working right away; whatever uses it gets 401 from then on.
        </p>
        <div className="mt-5 flex justify-end gap-2">
          <Button onClick={() => setRevoking(null)}>Cancel</Button>
          <Button
            variant="danger"
            onClick={async () => {
              await api.remove(revoking!.id)
              setRevoking(null)
              await list.reload()
            }}
          >
            Revoke
          </Button>
        </div>
      </Modal>
    </>
  )
}

/** The token, once, with how to use it. */
function TokenShown({ token, onClose }: { token: ApiToken & { token: string }; onClose: () => void }) {
  const [copied, setCopied] = useState(false)
  const origin = window.location.origin
  return (
    <Modal open onClose={onClose} title={`Token for ${token.name}`} wide>
      <div className="space-y-3 text-sm">
        <p className="text-zinc-600 dark:text-zinc-400">Copy it now: it isn't shown again. Keep it where your CI keeps secrets.</p>
        <div className="flex items-center gap-2">
          <code className="min-w-0 flex-1 rounded-lg bg-zinc-100 px-3 py-2 font-mono text-xs break-all select-all dark:bg-zinc-800" aria-label="API token">
            {token.token}
          </code>
          <Button
            size="sm"
            icon={copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
            onClick={() =>
              void navigator.clipboard
                .writeText(token.token)
                .then(() => setCopied(true))
                .catch(() => undefined)
            }
          >
            {copied ? 'Copied' : 'Copy'}
          </Button>
        </div>
        <p className="text-xs text-zinc-500 dark:text-zinc-400">For example, a dry-run highstate on the web tier:</p>
        <pre className="overflow-x-auto rounded-lg bg-zinc-100 p-3 font-mono text-xs dark:bg-zinc-800">{`curl -s ${origin}/api/salt \\
  -H "Authorization: Bearer $SALT_SHAKER_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{"client":"local","tgt":"web-*","fun":"state.apply","kwarg":{"test":true}}'`}</pre>
        <div className="flex justify-end">
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        </div>
      </div>
    </Modal>
  )
}
