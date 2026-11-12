import { useAutomationApi } from '../lib/automation'
import { BellRing, Check, Copy, KeyRound, Pencil, Plus, Send, Trash2 } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { type Channel, type NotifyEvent } from '../api/server'
import { Badge, Button, Card, CardHeader, Empty, ErrorBox, Field, Input, Modal, PageHeader, Select, Spinner, Switch } from '../components/ui'
import { useAsync } from '../lib/hooks'
import { relTime } from '../lib/format'

const FORMAT: Record<Channel['kind'], { label: string; placeholder: string }> = {
  slack: { label: 'Slack format', placeholder: 'https://hooks.slack.com/services/…' },
  teams: { label: 'Microsoft Teams', placeholder: 'https://….logic.azure.com/workflows/…' },
  webhook: { label: 'JSON webhook', placeholder: 'https://alerts.example.com/salt' },
  email: { label: 'Email', placeholder: 'ops@example.com, cto@example.com' },
}

const EVENT_SHORT: Record<NotifyEvent, string> = {
  drift: 'Drift',
  patches: 'Patches',
  vulns: 'Vulnerabilities',
  osquery: 'Query changes',
  acceptance: 'Risk acceptances',
  approval: 'Approvals',
  change: 'Changes',
  schedule: 'Every scheduled run',
  job_failed: 'Failed jobs',
  pending_key: 'Pending keys',
  minion_down: 'Minions down',
  report: 'Weekly report',
}

export function NotificationsPage() {
  const api = useAutomationApi()
  const list = useAsync(() => api.channels(), [])
  const meta = useAsync(() => api.meta(), [])
  const [editing, setEditing] = useState<Channel | 'new' | null>(null)
  const [removing, setRemoving] = useState<Channel | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<Error | null>(null)
  const [tested, setTested] = useState<Record<number, string>>({})
  // a signing secret is shown once: right after it's made
  const [secret, setSecret] = useState<{ name: string; value: string } | null>(null)
  const [rotating, setRotating] = useState<Channel | null>(null)

  const act = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key)
    setError(null)
    try {
      await fn()
    } catch (e) {
      setError(e as Error)
    } finally {
      setBusy(null)
      await list.reload()
    }
  }

  return (
    <>
      <PageHeader
        title="Notifications"
        description="Where alerts go. Slack-format webhooks also work with Mattermost, Rocket.Chat and Discord (append /slack to its webhook URL); anything else can take the generic JSON webhook."
        actions={
          <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setEditing('new')}>
            Add channel
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
        {list.data && list.data.channels.length === 0 && (
          <Empty icon={<BellRing />} title="No channels yet">
            Add a Slack or webhook channel to hear about drift, failed jobs and new minions.
          </Empty>
        )}
        {list.data && list.data.channels.length > 0 && (
          <ul className="divide-y divide-zinc-100 dark:divide-zinc-800/70">
            {list.data.channels.map((ch) => (
              <li key={ch.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
                <Switch checked={ch.enabled} label={`Enable ${ch.name}`} disabled={busy === `toggle:${ch.id}`} onChange={(v) => act(`toggle:${ch.id}`, () => api.updateChannel(ch.id, { enabled: v }))} />
                <div className="min-w-48 flex-1">
                  <p className="flex items-center gap-2">
                    <span className="font-medium">{ch.name}</span>
                    <Badge>{FORMAT[ch.kind]?.label ?? ch.kind}</Badge>
                    {ch.kind === 'webhook' &&
                      (ch.signed ? (
                        <Badge tone="green" title="Requests carry an X-Salt-Shaker-Signature header the receiver can check">
                          signed
                        </Badge>
                      ) : (
                        <Badge tone="amber" title="Make a signing secret so the receiver can tell the requests are from Salt Shaker">
                          unsigned
                        </Badge>
                      ))}
                  </p>
                  <p className="mt-0.5 font-mono text-xs text-zinc-500 dark:text-zinc-400">{ch.url}</p>
                </div>
                <div className="flex max-w-xs flex-wrap gap-1">
                  {ch.events.map((e) => (
                    <Badge key={e} tone="accent">
                      {EVENT_SHORT[e] ?? e}
                    </Badge>
                  ))}
                </div>
                <div className="w-48 text-xs">
                  {ch.lastError ? (
                    <p className="text-red-600 dark:text-red-400" title={ch.lastError}>
                      Last attempt failed: {ch.lastError.slice(0, 60)}
                    </p>
                  ) : ch.lastSentAt ? (
                    <p className="text-zinc-500 dark:text-zinc-400">Last sent {relTime(new Date(ch.lastSentAt))}</p>
                  ) : (
                    <p className="text-zinc-500 dark:text-zinc-400">Nothing sent yet</p>
                  )}
                  {tested[ch.id] && <p className="text-emerald-700">{tested[ch.id]}</p>}
                </div>
                <div className="flex gap-1">
                  <Button
                    size="sm"
                    variant="ghost"
                    icon={<Send className="size-3.5" />}
                    loading={busy === `test:${ch.id}`}
                    onClick={() =>
                      act(`test:${ch.id}`, async () => {
                        await api.testChannel(ch.id)
                        setTested((m) => ({ ...m, [ch.id]: 'Test message sent' }))
                      })
                    }
                  >
                    Test
                  </Button>
                  {ch.kind === 'webhook' && (
                    <Button size="sm" variant="ghost" icon={<KeyRound className="size-3.5" />} onClick={() => setRotating(ch)} title="Make a new signing secret">
                      {ch.signed ? 'New secret' : 'Sign'}
                    </Button>
                  )}
                  <Button size="sm" variant="ghost" icon={<Pencil className="size-3.5" />} onClick={() => setEditing(ch)}>
                    Edit
                  </Button>
                  <Button size="sm" variant="ghost" icon={<Trash2 className="size-3.5" />} onClick={() => setRemoving(ch)} aria-label={`Delete ${ch.name}`} />
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <WeeklyReportCard subscribed={list.data?.channels.filter((ch) => ch.enabled && ch.events.includes('report')).length ?? 0} onSent={list.reload} />

      {editing && (
        <ChannelModal channel={editing === 'new' ? null : editing} events={meta.data?.events} emailOff={meta.data?.email === false} onClose={() => setEditing(null)} onSaved={list.reload} onSecret={(name, value) => setSecret({ name, value })} />
      )}

      <Modal open={!!rotating} onClose={() => setRotating(null)} title={rotating?.signed ? 'New signing secret?' : 'Sign this webhook?'}>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          {rotating?.signed ? (
            <>
              <strong>{rotating?.name}</strong> gets a new secret, and the old one stops working right away: update the receiver with the new one.
            </>
          ) : (
            <>
              Requests to <strong>{rotating?.name}</strong> will carry a signature the receiver can check with the secret shown next.
            </>
          )}
        </p>
        <div className="mt-5 flex justify-end gap-2">
          <Button onClick={() => setRotating(null)}>Cancel</Button>
          <Button
            variant="primary"
            icon={<KeyRound className="size-4" />}
            loading={busy === 'rotate'}
            onClick={async () => {
              const ch = rotating!
              await act('rotate', async () => {
                const { secret: value } = await api.rotateSecret(ch.id)
                setSecret({ name: ch.name, value })
              })
              setRotating(null)
            }}
          >
            {rotating?.signed ? 'Make a new secret' : 'Make a secret'}
          </Button>
        </div>
      </Modal>

      {secret && <SecretModal name={secret.name} value={secret.value} onClose={() => setSecret(null)} />}

      <Modal open={!!removing} onClose={() => setRemoving(null)} title="Delete channel?">
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          <strong>{removing?.name}</strong> will stop receiving alerts.
        </p>
        <div className="mt-5 flex justify-end gap-2">
          <Button onClick={() => setRemoving(null)}>Cancel</Button>
          <Button
            variant="danger"
            icon={<Trash2 className="size-4" />}
            loading={busy === 'delete'}
            onClick={async () => {
              await act('delete', () => api.deleteChannel(removing!.id))
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

/** Shows a webhook's signing secret, once, with how the receiver checks it. */
function SecretModal({ name, value, onClose }: { name: string; value: string; onClose: () => void }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
    } catch {
      // select it by hand
    }
  }
  return (
    <Modal open onClose={onClose} title={`Signing secret for ${name}`}>
      <div className="space-y-3 text-sm">
        <p className="text-zinc-600 dark:text-zinc-400">Copy it to the receiver now: it isn't shown again. A new one can be made at any time.</p>
        <div className="flex items-center gap-2">
          <code className="min-w-0 flex-1 rounded-lg bg-zinc-100 px-3 py-2 font-mono text-xs break-all select-all dark:bg-zinc-800" aria-label="Signing secret">
            {value}
          </code>
          <Button size="sm" icon={copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />} onClick={() => void copy()}>
            {copied ? 'Copied' : 'Copy'}
          </Button>
        </div>
        <p className="text-xs text-zinc-500 dark:text-zinc-400">
          Each request has <code className="font-mono">X-Salt-Shaker-Timestamp</code> and <code className="font-mono">X-Salt-Shaker-Signature: sha256=…</code>, the HMAC-SHA256 of <code className="font-mono">timestamp.body</code> with this secret.
        </p>
        <div className="flex justify-end">
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        </div>
      </div>
    </Modal>
  )
}

function ChannelModal({ channel, events, emailOff, onClose, onSaved, onSecret }: { channel: Channel | null; events?: Record<NotifyEvent, string>; emailOff?: boolean; onClose: () => void; onSaved: () => void; onSecret: (name: string, secret: string) => void }) {
  const api = useAutomationApi()
  const [name, setName] = useState(channel?.name ?? '')
  const [kind, setKind] = useState<Channel['kind']>(channel?.kind ?? 'slack')
  const [url, setUrl] = useState('')
  const [chosen, setChosen] = useState<Set<NotifyEvent>>(new Set(channel?.events ?? ['drift', 'job_failed', 'pending_key', 'minion_down']))
  const [error, setError] = useState<Error | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      if (channel) await api.updateChannel(channel.id, { name: name.trim(), events: [...chosen], ...(url.trim() ? { url: url.trim() } : {}) })
      else {
        const created = await api.createChannel({ name: name.trim(), kind, url: url.trim(), events: [...chosen] })
        if (created?.secret) onSecret(name.trim(), created.secret)
      }
      onSaved()
      onClose()
    } catch (err) {
      setError(err as Error)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal open onClose={onClose} title={channel ? `Edit ${channel.name}` : 'Add channel'}>
      <form onSubmit={submit} className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="#ops-alerts" required autoFocus />
          </Field>
          <Field label="Format">
            <Select value={kind} onChange={(e) => setKind(e.target.value as Channel['kind'])} disabled={!!channel}>
              <option value="slack">Slack-compatible</option>
              <option value="teams">Microsoft Teams</option>
              <option value="webhook">Generic JSON webhook</option>
              <option value="email">Email</option>
            </Select>
          </Field>
        </div>
        {kind === 'email' ? (
          <Field
            label="Recipients"
            hint={
              emailOff
                ? 'Email is off on this server: set SMTP_URL (and SMTP_FROM) to send. You can add the channel now.'
                : channel
                  ? `Currently ${channel.url}. Leave empty to keep them.`
                  : 'Up to 20 addresses, separated by commas. Use a mailing list for more.'
            }
          >
            <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder={FORMAT.email.placeholder} required={!channel} aria-label="Recipients" />
          </Field>
        ) : (
          <Field label="Webhook URL" hint={channel ? `Currently ${channel.url}. Leave empty to keep it.` : 'Stored on the server and never shown in full again.'}>
            <Input type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder={FORMAT[kind].placeholder} required={!channel} className="font-mono" />
          </Field>
        )}
        <fieldset className="space-y-2">
          <legend className="mb-1 text-xs font-medium text-zinc-600 dark:text-zinc-400">Send when</legend>
          {Object.entries(events ?? EVENT_SHORT).map(([key, label]) => (
            <label key={key} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={chosen.has(key as NotifyEvent)}
                onChange={(e) =>
                  setChosen((s) => {
                    const n = new Set(s)
                    if (e.target.checked) n.add(key as NotifyEvent)
                    else n.delete(key as NotifyEvent)
                    return n
                  })
                }
                className="accent-accent-600"
              />
              {label}
            </label>
          ))}
        </fieldset>
        {error && <ErrorBox error={error} />}
        <div className="flex justify-end gap-2">
          <Button type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" loading={busy} disabled={chosen.size === 0}>
            {channel ? 'Save' : 'Add channel'}
          </Button>
        </div>
      </form>
    </Modal>
  )
}

/** This week's report as it would go out now, and a button to send it. */
function WeeklyReportCard({ subscribed, onSent }: { subscribed: number; onSent: () => void }) {
  const api = useAutomationApi()
  const report = useAsync(() => api.weeklyReport(), [])
  const [busy, setBusy] = useState(false)
  const [sent, setSent] = useState(false)
  const [error, setError] = useState<Error | null>(null)
  const r = report.data?.report
  return (
    <Card className="mt-6">
      <CardHeader
        title="Weekly report"
        subtitle={`How the fleet did over the last seven days, sent on Mondays at 8:00 (the server's time) to the channels that take Weekly report: ${subscribed === 1 ? '1 channel' : `${subscribed} channels`} now.`}
        actions={
          <Button
            size="sm"
            icon={sent ? <Check className="size-3.5" /> : <Send className="size-3.5" />}
            loading={busy}
            disabled={!subscribed}
            title={subscribed ? undefined : 'Tick Weekly report on a channel first'}
            onClick={async () => {
              setBusy(true)
              setError(null)
              try {
                await api.sendWeeklyReport()
                setSent(true)
                onSent()
              } catch (e) {
                setError(e as Error)
              } finally {
                setBusy(false)
              }
            }}
          >
            {sent ? 'Sent' : 'Send now'}
          </Button>
        }
      />
      <div className="p-4 text-sm">
        {error && (
          <div className="mb-3">
            <ErrorBox error={error} />
          </div>
        )}
        {report.error && <ErrorBox error={report.error} onRetry={report.reload} />}
        {report.loading && !r && <Spinner />}
        {r && (
          <div className="rounded-lg border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-800 dark:bg-zinc-950/40">
            <p className="font-medium">{r.title}</p>
            <ul className="mt-1 space-y-0.5 text-zinc-600 dark:text-zinc-400">
              {r.lines.map((l) => (
                <li key={l}>{l}</li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </Card>
  )
}

