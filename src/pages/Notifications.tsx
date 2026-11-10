import { BellRing, Pencil, Plus, Send, Trash2 } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { automation, type Channel, type NotifyEvent } from '../api/server'
import { Badge, Button, Card, Empty, ErrorBox, Field, Input, Modal, PageHeader, Select, Spinner, Switch } from '../components/ui'
import { useAsync } from '../lib/hooks'
import { relTime } from '../lib/format'

const FORMAT: Record<Channel['kind'], { label: string; placeholder: string }> = {
  slack: { label: 'Slack format', placeholder: 'https://hooks.slack.com/services/…' },
  teams: { label: 'Microsoft Teams', placeholder: 'https://….logic.azure.com/workflows/…' },
  webhook: { label: 'JSON webhook', placeholder: 'https://alerts.example.com/salt' },
}

const EVENT_SHORT: Record<NotifyEvent, string> = {
  drift: 'Drift',
  patches: 'Patches',
  vulns: 'Vulnerabilities',
  osquery: 'Query changes',
  schedule: 'Every scheduled run',
  job_failed: 'Failed jobs',
  pending_key: 'Pending keys',
  minion_down: 'Minions down',
}

export function NotificationsPage() {
  const list = useAsync(() => automation.channels(), [])
  const meta = useAsync(() => automation.meta(), [])
  const [editing, setEditing] = useState<Channel | 'new' | null>(null)
  const [removing, setRemoving] = useState<Channel | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<Error | null>(null)
  const [tested, setTested] = useState<Record<number, string>>({})

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
                <Switch checked={ch.enabled} label={`Enable ${ch.name}`} disabled={busy === `toggle:${ch.id}`} onChange={(v) => act(`toggle:${ch.id}`, () => automation.updateChannel(ch.id, { enabled: v }))} />
                <div className="min-w-48 flex-1">
                  <p className="flex items-center gap-2">
                    <span className="font-medium">{ch.name}</span>
                    <Badge>{FORMAT[ch.kind]?.label ?? ch.kind}</Badge>
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
                        await automation.testChannel(ch.id)
                        setTested((m) => ({ ...m, [ch.id]: 'Test message sent' }))
                      })
                    }
                  >
                    Test
                  </Button>
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

      {editing && <ChannelModal channel={editing === 'new' ? null : editing} events={meta.data?.events} onClose={() => setEditing(null)} onSaved={list.reload} />}

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
              await act('delete', () => automation.deleteChannel(removing!.id))
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

function ChannelModal({ channel, events, onClose, onSaved }: { channel: Channel | null; events?: Record<NotifyEvent, string>; onClose: () => void; onSaved: () => void }) {
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
      if (channel) await automation.updateChannel(channel.id, { name: name.trim(), events: [...chosen], ...(url.trim() ? { url: url.trim() } : {}) })
      else await automation.createChannel({ name: name.trim(), kind, url: url.trim(), events: [...chosen] })
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
            </Select>
          </Field>
        </div>
        <Field label="Webhook URL" hint={channel ? `Currently ${channel.url}. Leave empty to keep it.` : 'Stored on the server and never shown in full again.'}>
          <Input type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder={FORMAT[kind].placeholder} required={!channel} className="font-mono" />
        </Field>
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
