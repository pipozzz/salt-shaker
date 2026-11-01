import clsx from 'clsx'
import { Ban, Check, CheckCheck, Fingerprint, KeyRound, Plus, RefreshCw, ShieldAlert, ShieldCheck, Trash2, Undo2 } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import type { KeyList } from '../api/types'
import { Badge, Button, Card, CardHeader, CopyButton, Empty, ErrorBox, Field, Input, Modal, PageHeader, Spinner, Tabs } from '../components/ui'
import { useAsync, useStoredState } from '../lib/hooks'
import { useSalt, useSession } from '../lib/session'

type Action = 'accept' | 'reject' | 'delete'

export function KeysPage() {
  const salt = useSalt()
  const { events } = useSession()
  const [busy, setBusy] = useState<string | null>(null)
  const [actionError, setActionError] = useState<Error | null>(null)
  const [enrollOpen, setEnrollOpen] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)

  const { data, error, loading, reload } = useAsync(async () => {
    const [keys, fingers] = await Promise.all([salt.keys(), salt.fingerprints().catch(() => ({}) as Record<string, string>)])
    return { keys, fingers }
  }, [salt])

  // a new minion knocking (salt/auth) or a key change elsewhere refreshes the lists
  const lastKeyEvent = events.find((e) => e.tag === 'salt/auth' || e.tag === 'salt/key')
  useEffect(() => {
    if (lastKeyEvent) void reload()
  }, [lastKeyEvent, reload])

  const act = async (action: Action, id: string) => {
    setBusy(`${action}:${id}`)
    setActionError(null)
    try {
      if (action === 'accept') await salt.acceptKey(id)
      if (action === 'reject') await salt.rejectKey(id)
      if (action === 'delete') await salt.deleteKey(id)
      await reload()
    } catch (e) {
      setActionError(e as Error)
    } finally {
      setBusy(null)
    }
  }

  const acceptAll = async () => {
    if (!data) return
    setBusy('accept:*')
    try {
      for (const id of data.keys.minions_pre) await salt.acceptKey(id)
      await reload()
    } catch (e) {
      setActionError(e as Error)
    } finally {
      setBusy(null)
    }
  }

  const k: KeyList | undefined = data?.keys

  return (
    <>
      <PageHeader
        title="Enrollment"
        description="Approve new minions, manage keys, and generate bootstrap commands."
        actions={
          <>
            <Button icon={<RefreshCw className={clsx('size-4', loading && 'animate-spin')} />} onClick={reload} disabled={loading}>
              Refresh
            </Button>
            <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setEnrollOpen(true)}>
              Enroll minion
            </Button>
          </>
        }
      />

      {error && <ErrorBox error={error} onRetry={reload} />}
      {actionError && (
        <div className="mb-4">
          <ErrorBox error={actionError} />
        </div>
      )}
      {!data && loading && <Spinner />}

      {k && (
        <div className="space-y-6">
          <Card className={clsx(k.minions_pre.length > 0 && 'ring-2 ring-amber-400/40 dark:ring-amber-500/30')}>
            <CardHeader
              title={
                <span className="flex items-center gap-2">
                  <ShieldAlert className="size-4 text-amber-500" /> Pending approval
                  <Badge tone={k.minions_pre.length ? 'amber' : 'zinc'}>{k.minions_pre.length}</Badge>
                </span>
              }
              subtitle="Compare the fingerprint with `salt-call --local key.finger` on the minion before accepting."
              actions={
                k.minions_pre.length > 1 && (
                  <Button size="sm" variant="success" icon={<CheckCheck className="size-3.5" />} loading={busy === 'accept:*'} onClick={acceptAll}>
                    Accept all
                  </Button>
                )
              }
            />
            {k.minions_pre.length === 0 ? (
              <Empty icon={<ShieldCheck />} title="No minions waiting">
                New minions show up here as soon as they contact the master.
              </Empty>
            ) : (
              <KeyRows ids={k.minions_pre} fingers={data?.fingers ?? {}}>
                {(id) => (
                  <>
                    <Button size="sm" variant="success" icon={<Check className="size-3.5" />} loading={busy === `accept:${id}`} onClick={() => act('accept', id)}>
                      Accept
                    </Button>
                    <Button size="sm" variant="danger" icon={<Ban className="size-3.5" />} loading={busy === `reject:${id}`} onClick={() => act('reject', id)}>
                      Reject
                    </Button>
                  </>
                )}
              </KeyRows>
            )}
          </Card>

          <Card>
            <CardHeader title={<span className="flex items-center gap-2">Accepted <Badge tone="green">{k.minions.length}</Badge></span>} />
            {k.minions.length === 0 ? (
              <Empty icon={<KeyRound />} title="No accepted keys" />
            ) : (
              <KeyRows ids={k.minions} fingers={data?.fingers ?? {}}>
                {(id) => (
                  <>
                    <Button size="sm" variant="ghost" icon={<Ban className="size-3.5" />} loading={busy === `reject:${id}`} onClick={() => act('reject', id)}>
                      Reject
                    </Button>
                    <Button size="sm" variant="ghost" icon={<Trash2 className="size-3.5" />} onClick={() => setConfirmDelete(id)}>
                      Delete
                    </Button>
                  </>
                )}
              </KeyRows>
            )}
          </Card>

          {(k.minions_rejected.length > 0 || k.minions_denied.length > 0) && (
            <Card>
              <CardHeader
                title={
                  <span className="flex items-center gap-2">
                    Rejected & denied <Badge tone="red">{k.minions_rejected.length + k.minions_denied.length}</Badge>
                  </span>
                }
                subtitle="Denied keys belong to a minion id that already has a different accepted key."
              />
              <KeyRows ids={[...k.minions_rejected, ...k.minions_denied]} fingers={data?.fingers ?? {}} tag={(id) => (k.minions_denied.includes(id) ? <Badge tone="red">denied</Badge> : null)}>
                {(id) => (
                  <>
                    <Button size="sm" variant="ghost" icon={<Undo2 className="size-3.5" />} loading={busy === `accept:${id}`} onClick={() => act('accept', id)}>
                      Accept
                    </Button>
                    <Button size="sm" variant="ghost" icon={<Trash2 className="size-3.5" />} onClick={() => setConfirmDelete(id)}>
                      Delete
                    </Button>
                  </>
                )}
              </KeyRows>
            </Card>
          )}
        </div>
      )}

      <Modal open={!!confirmDelete} onClose={() => setConfirmDelete(null)} title="Delete key?">
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          The key for <span className="font-mono font-medium text-zinc-900 dark:text-zinc-100">{confirmDelete}</span> will be removed from the master. If the minion is still running it
          will re-submit its key and land in <em>Pending</em> again.
        </p>
        <div className="mt-5 flex justify-end gap-2">
          <Button onClick={() => setConfirmDelete(null)}>Cancel</Button>
          <Button
            variant="danger"
            icon={<Trash2 className="size-4" />}
            loading={busy === `delete:${confirmDelete}`}
            onClick={async () => {
              await act('delete', confirmDelete!)
              setConfirmDelete(null)
            }}
          >
            Delete key
          </Button>
        </div>
      </Modal>

      <EnrollModal open={enrollOpen} onClose={() => setEnrollOpen(false)} existing={k} onEnrolled={reload} />
    </>
  )
}

function KeyRows({ ids, fingers, children, tag }: { ids: string[]; fingers: Record<string, string>; children: (id: string) => ReactNode; tag?: (id: string) => ReactNode }) {
  return (
    <ul className="divide-y divide-zinc-100 dark:divide-zinc-800/70">
      {[...ids].sort().map((id) => (
        <li key={id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2.5">
          <span className="font-mono text-sm font-medium">{id}</span>
          {tag?.(id)}
          {fingers[id] && (
            <span className="flex min-w-0 items-center gap-1.5 text-xs text-zinc-500" title={fingers[id]}>
              <Fingerprint className="size-3.5 shrink-0" />
              <span className="truncate font-mono">{fingers[id].slice(0, 23)}…</span>
            </span>
          )}
          <span className="ml-auto flex gap-1.5">{children(id)}</span>
        </li>
      ))}
    </ul>
  )
}

const BOOTSTRAP_URL = 'https://github.com/saltstack/salt-bootstrap/releases/latest/download/bootstrap-salt.sh'

function bootstrapCmd(id: string, master: string, roles: string[]) {
  const cfg = roles.length ? ` -j '${JSON.stringify({ grains: { roles } })}'` : ''
  return `curl -fsSL ${BOOTSTRAP_URL} -o /tmp/bootstrap-salt.sh\nsudo sh /tmp/bootstrap-salt.sh -i ${id} -A ${master}${cfg} stable`
}

function EnrollModal({ open, onClose, existing, onEnrolled }: { open: boolean; onClose: () => void; existing?: KeyList; onEnrolled: () => void }) {
  const salt = useSalt()
  const [method, setMethod] = useState<'approve' | 'preseed'>('approve')
  const [id, setId] = useState('')
  const [master, setMaster] = useStoredState('salt-shaker.enroll.master', window.location.hostname === 'localhost' ? 'salt.example.com' : window.location.hostname)
  const [roles, setRoles] = useState('')
  const [keys, setKeys] = useState<{ pub: string; priv: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<Error | null>(null)

  useEffect(() => {
    if (!open) {
      setKeys(null)
      setError(null)
      setId('')
    }
  }, [open])

  const roleList = roles.split(/[\s,]+/).filter(Boolean)
  const validId = /^[A-Za-z0-9][\w.-]*$/.test(id)
  const taken = existing && [...existing.minions, ...existing.minions_pre, ...existing.minions_rejected, ...existing.minions_denied].includes(id)

  const generate = async () => {
    setBusy(true)
    setError(null)
    try {
      setKeys(await salt.genAccept(id))
      onEnrolled()
    } catch (e) {
      setError(e as Error)
    } finally {
      setBusy(false)
    }
  }

  const preseedScript = keys
    ? `# Pre-seeded keys for ${id} (already accepted on the master)\nsudo install -d -m 700 /etc/salt/pki/minion\nsudo tee /etc/salt/pki/minion/minion.pem >/dev/null <<'EOF'\n${keys.priv.trim()}\nEOF\nsudo tee /etc/salt/pki/minion/minion.pub >/dev/null <<'EOF'\n${keys.pub.trim()}\nEOF\nsudo chmod 400 /etc/salt/pki/minion/minion.pem\n\n${bootstrapCmd(id, master, roleList)}`
    : ''

  return (
    <Modal open={open} onClose={onClose} title="Enroll a new minion" wide>
      <div className="space-y-5">
        <Tabs
          value={method}
          onChange={(m) => {
            setMethod(m)
            setKeys(null)
          }}
          items={[
            { value: 'approve', label: 'Install, then approve' },
            { value: 'preseed', label: 'Pre-seeded keys' },
          ]}
        />
        <p className="text-sm text-zinc-500">
          {method === 'approve'
            ? 'Run the bootstrap on the new host. Its key appears under Pending, where you verify the fingerprint and accept it.'
            : 'The master generates and accepts a keypair now. The script installs it on the host, so the minion is trusted on first contact — no approval step.'}
        </p>

        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Minion id">
            <Input value={id} onChange={(e) => setId(e.target.value.trim())} placeholder="web-03" disabled={!!keys} />
          </Field>
          <Field label="Master address">
            <Input value={master} onChange={(e) => setMaster(e.target.value.trim())} placeholder="salt.example.com" />
          </Field>
          <Field label="Roles grain (optional)">
            <Input value={roles} onChange={(e) => setRoles(e.target.value)} placeholder="web, nginx" />
          </Field>
        </div>
        {id && !validId && <p className="text-xs text-red-600">Use letters, digits, dots, dashes and underscores.</p>}
        {taken && !keys && <p className="text-xs text-amber-600">A key named {id} already exists on the master.</p>}

        {method === 'approve' && id && validId && master && <Script code={bootstrapCmd(id, master, roleList)} />}

        {method === 'preseed' && !keys && (
          <Button variant="primary" icon={<KeyRound className="size-4" />} disabled={!validId || !master || !!taken} loading={busy} onClick={generate}>
            Generate & accept keypair
          </Button>
        )}
        {method === 'preseed' && keys && (
          <>
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-900/50 dark:bg-amber-500/10 dark:text-amber-300">
              This script contains the minion's <strong>private key</strong>. It is shown only once — copy it now and run it over a trusted channel.
            </div>
            <Script code={preseedScript} />
          </>
        )}
        {error && <ErrorBox error={error} />}
      </div>
    </Modal>
  )
}

function Script({ code }: { code: string }) {
  return (
    <div className="overflow-hidden rounded-lg border border-zinc-200 dark:border-zinc-800">
      <div className="flex items-center justify-between border-b border-zinc-200 bg-zinc-50 px-3 py-1 dark:border-zinc-800 dark:bg-zinc-900">
        <span className="text-xs font-medium text-zinc-500">bash</span>
        <CopyButton text={code} />
      </div>
      <pre className="max-h-72 overflow-auto bg-zinc-950 p-3 font-mono text-[12px] leading-5 text-zinc-100">{code}</pre>
    </div>
  )
}
