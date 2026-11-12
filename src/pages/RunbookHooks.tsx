import { KeyRound, Pencil, Plus, Send, Trash2, Webhook } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import type { Runbook, RunbookHook } from '../api/server'
import { Badge, Button, Card, CardHeader, ErrorBox, Field, Input, Modal, Select, Switch } from '../components/ui'
import { relTime } from '../lib/format'
import { useAsync } from '../lib/hooks'
import { sampleBody } from '../lib/runbook-hook'
import { hookUrl, useRunbookHooksApi } from '../lib/runbooks'

/** Admins' list of the webhooks that start runbooks, with their secrets shown once. */
export function RunbookHooksCard({ runbooks, onChanged }: { runbooks: Runbook[]; onChanged?: () => void }) {
  const api = useRunbookHooksApi()
  const [reloads, setReloads] = useState(0)
  const list = useAsync(() => (api ? api.list() : Promise.resolve(null)), [api, reloads])
  const reload = () => setReloads((n) => n + 1)
  const [editing, setEditing] = useState<RunbookHook | 'new' | null>(null)
  const [secret, setSecret] = useState<{ hook: RunbookHook; secret: string } | null>(null)
  const [testing, setTesting] = useState<RunbookHook | null>(null)
  const [removing, setRemoving] = useState<RunbookHook | null>(null)
  const [error, setError] = useState<Error | null>(null)
  if (!api) return null
  const name = (id: number) => runbooks.find((rb) => rb.id === id)?.name

  const act = async (fn: () => Promise<unknown>) => {
    setError(null)
    try {
      await fn()
      reload()
    } catch (e) {
      setError(e as Error)
    }
  }

  return (
    <Card className="mt-6">
      <CardHeader
        title="Webhooks"
        subtitle="Let monitoring, CI or a ticket system start a runbook with a secret, without signing in."
        actions={
          runbooks.length > 0 && (
            <Button size="sm" icon={<Plus className="size-3.5" />} onClick={() => setEditing('new')}>
              New webhook
            </Button>
          )
        }
      />
      {error && (
        <div className="p-4 pb-0">
          <ErrorBox error={error} />
        </div>
      )}
      {list.error && (
        <div className="p-4">
          <ErrorBox error={list.error} onRetry={list.reload} />
        </div>
      )}
      {list.data && list.data.hooks.length === 0 && <p className="p-4 text-sm text-zinc-500 dark:text-zinc-400">No webhooks yet.</p>}
      {list.data && list.data.hooks.length > 0 && (
        <ul className="divide-y divide-zinc-100 dark:divide-zinc-800/70">
          {list.data.hooks.map((h) => (
            <li key={h.id} className="flex flex-wrap items-start gap-x-4 gap-y-2 px-4 py-3" aria-label={h.name}>
              <div className="pt-0.5">
                <Switch checked={h.enabled} label={`Turn ${h.name} ${h.enabled ? 'off' : 'on'}`} onChange={(v) => act(() => api.update(h.id, { enabled: v }))} />
              </div>
              <div className="min-w-60 flex-1 space-y-1 text-sm">
                <p className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{h.name}</span>
                  {name(h.runbookId) ? <Badge tone="green">{name(h.runbookId)}</Badge> : <Badge tone="red">its runbook is gone</Badge>}
                </p>
                <p className="font-mono text-xs break-all text-zinc-500 dark:text-zinc-400">POST {hookUrl(h.id)}</p>
                <p className="text-xs text-zinc-500 dark:text-zinc-400">
                  {Object.entries(h.params).map(([k, v]) => (
                    <span key={k} className="mr-2 font-mono">
                      {k}={v}
                    </span>
                  ))}
                  {h.fromRequest.length > 0 ? (
                    <>
                      the call sets <span className="font-mono">{h.fromRequest.join(', ')}</span>
                    </>
                  ) : (
                    'the call sets nothing'
                  )}
                </p>
                <p className="text-xs text-zinc-500 dark:text-zinc-400">
                  {h.lastCalledAt ? `called ${relTime(new Date(h.lastCalledAt))}` : 'never called'}
                  {h.lastError ? (
                    <span className="text-red-700 dark:text-red-400"> · {h.lastError}</span>
                  ) : (
                    h.lastRunId && (
                      <>
                        {' · '}
                        <Link to={`/runbooks/runs/${h.lastRunId}`} className="text-accent-700 hover:underline dark:text-accent-400">
                          run #{h.lastRunId}
                        </Link>
                      </>
                    )
                  )}
                </p>
              </div>
              <div className="flex gap-1">
                <Button size="sm" variant="ghost" icon={<Send className="size-3.5" />} disabled={!h.enabled} onClick={() => setTesting(h)}>
                  Test call…
                </Button>
                <Button size="sm" variant="ghost" icon={<KeyRound className="size-3.5" />} onClick={() => act(async () => setSecret({ hook: h, secret: (await api.rotate(h.id)).secret }))}>
                  New secret
                </Button>
                <Button size="sm" variant="ghost" icon={<Pencil className="size-3.5" />} aria-label={`Edit ${h.name}`} onClick={() => setEditing(h)} />
                <Button size="sm" variant="ghost" icon={<Trash2 className="size-3.5" />} aria-label={`Delete ${h.name}`} onClick={() => setRemoving(h)} />
              </div>
            </li>
          ))}
        </ul>
      )}

      {editing && (
        <HookEditor
          hook={editing === 'new' ? null : editing}
          runbooks={runbooks}
          onClose={() => setEditing(null)}
          onSaved={(made) => {
            reload()
            onChanged?.()
            if (made) setSecret(made)
          }}
        />
      )}
      {secret && <SecretModal hook={secret.hook} secret={secret.secret} onClose={() => setSecret(null)} />}
      {testing && <TestCall hook={testing} onClose={() => setTesting(null)} />}
      <Modal open={!!removing} onClose={() => setRemoving(null)} title={`Delete ${removing?.name}?`}>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">Calls to it stop working right away. The runs it started stay.</p>
        <div className="mt-5 flex justify-end gap-2">
          <Button onClick={() => setRemoving(null)}>Cancel</Button>
          <Button
            variant="danger"
            onClick={async () => {
              const h = removing!
              setRemoving(null)
              await act(() => api.remove(h.id))
              onChanged?.()
            }}
          >
            Delete
          </Button>
        </div>
      </Modal>
    </Card>
  )
}

function HookEditor({ hook, runbooks, onClose, onSaved }: { hook: RunbookHook | null; runbooks: Runbook[]; onClose: () => void; onSaved: (made?: { hook: RunbookHook; secret: string }) => void }) {
  const api = useRunbookHooksApi()!
  const [name, setName] = useState(hook?.name ?? '')
  const [runbookId, setRunbookId] = useState(hook?.runbookId ?? runbooks[0]?.id ?? 0)
  const runbook = runbooks.find((rb) => rb.id === runbookId)
  const [values, setValues] = useState<Record<string, string>>(hook?.params ?? {})
  const [fromRequest, setFromRequest] = useState<string[]>(hook?.fromRequest ?? [])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<Error | null>(null)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    const input = { name: name.trim(), runbookId, params: values, fromRequest }
    try {
      if (hook) {
        await api.update(hook.id, input)
        onSaved()
      } else onSaved(await api.create(input))
      onClose()
    } catch (err) {
      setError(err as Error)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal open onClose={onClose} title={hook ? `Edit ${hook.name}` : 'New webhook'} wide>
      <form onSubmit={submit} className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Webhook name">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Alertmanager: nginx down" required autoFocus />
          </Field>
          <Field label="Runbook">
            <Select value={runbookId} onChange={(e) => setRunbookId(Number(e.target.value))} aria-label="Runbook it starts">
              {runbooks.map((rb) => (
                <option key={rb.id} value={rb.id}>
                  {rb.name}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        {!!runbook?.params.length && (
          <div className="space-y-2 rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
            <p className="text-xs text-zinc-500 dark:text-zinc-400">Set each value here, let the call set it, or both: then the call's wins and yours is the default.</p>
            {runbook.params.map((p) => (
              <div key={p.name} className="grid items-end gap-3 sm:grid-cols-[1fr_auto]">
                <Field label={p.label || p.name} hint={`{{${p.name}}}${p.required ? ', required' : ''}${p.default ? `, runbook default ${p.default}` : ''}`}>
                  <Input value={values[p.name] ?? ''} onChange={(e) => setValues((v) => ({ ...v, [p.name]: e.target.value }))} placeholder={p.default} className="font-mono" aria-label={`${p.label || p.name} value`} />
                </Field>
                <label className="flex h-9 items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="accent-accent-600"
                    checked={fromRequest.includes(p.name)}
                    onChange={(e) => setFromRequest((f) => (e.target.checked ? [...f, p.name] : f.filter((n) => n !== p.name)))}
                    aria-label={`The call may set ${p.label || p.name}`}
                  />
                  The call may set it
                </label>
              </div>
            ))}
            <p className="text-xs text-amber-800 dark:text-amber-300">A value the call sets is used as sent, targets too: let it set only what the runbook can take safely from whoever knows the secret.</p>
          </div>
        )}
        <p className="text-xs text-zinc-500 dark:text-zinc-400">
          Runs act as <span className="font-mono">hook:{name.trim() || '…'}</span> with an operator's rights, so with approvals on, a risky one waits for an admin. One run at a time: a call while the last run is going gets a 409.
        </p>
        {error && <ErrorBox error={error} />}
        <div className="flex justify-end gap-2">
          <Button type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" loading={busy}>
            {hook ? 'Save' : 'Create webhook'}
          </Button>
        </div>
      </form>
    </Modal>
  )
}

function SecretModal({ hook, secret, onClose }: { hook: RunbookHook; secret: string; onClose: () => void }) {
  const example = `curl -X POST ${hookUrl(hook.id)} \\
  -H "Authorization: Bearer ${secret}" \\
  -H "Content-Type: application/json" \\
  -d '${JSON.stringify(Object.fromEntries(hook.fromRequest.map((n) => [n, '…'])))}'`
  return (
    <Modal open onClose={onClose} title={`Secret for ${hook.name}`} wide>
      <div className="space-y-3 text-sm">
        <p className="text-zinc-600 dark:text-zinc-400">Copy it now: it isn't shown again. A call sends it as a bearer token, or signs its body with it like Salt Shaker's own webhooks.</p>
        <Input readOnly value={secret} className="font-mono" aria-label="Webhook secret" onFocus={(e) => e.currentTarget.select()} />
        <pre className="overflow-x-auto rounded-lg bg-zinc-100 p-3 font-mono text-xs dark:bg-zinc-900">{example}</pre>
        <div className="flex justify-end">
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        </div>
      </div>
    </Modal>
  )
}

/** Sends a body as a tool would, and opens the run it starts. */
function TestCall({ hook, onClose }: { hook: RunbookHook; onClose: () => void }) {
  const api = useRunbookHooksApi()!
  const navigate = useNavigate()
  const [body, setBody] = useState(sampleBody(hook.fromRequest))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<Error | null>(null)
  return (
    <Modal open onClose={onClose} title={`Test call to ${hook.name}`}>
      <form
        className="space-y-3"
        onSubmit={async (e) => {
          e.preventDefault()
          setBusy(true)
          setError(null)
          try {
            const r = await api.test(hook.id, body)
            navigate(r.path)
          } catch (err) {
            setError(err as Error)
            setBusy(false)
          }
        }}
      >
        <p className="text-sm text-zinc-600 dark:text-zinc-400">The body a tool would send. It starts a real run, as the webhook.</p>
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={6}
          spellCheck={false}
          aria-label="Request body"
          className="w-full rounded-lg border border-zinc-200 bg-white p-2 font-mono text-xs focus:border-accent-500 focus:outline-none dark:border-zinc-800 dark:bg-zinc-900"
        />
        {error && <ErrorBox error={error} />}
        <div className="flex justify-end gap-2">
          <Button type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" icon={<Webhook className="size-4" />} loading={busy}>
            Send
          </Button>
        </div>
      </form>
    </Modal>
  )
}
