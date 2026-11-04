import { Ban, KeyRound, Plus, RefreshCw, Trash2, Undo2, Users as UsersIcon } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { ROLES, users, type Role, type UserRow } from '../api/server'
import { Badge, Button, Card, Empty, ErrorBox, Field, Input, Modal, PageHeader, Select, Spinner, type Tone } from '../components/ui'
import { useAsync } from '../lib/hooks'
import { useSession } from '../lib/session'
import { relTime } from '../lib/format'

const ROLE_INFO: Record<Role, { tone: Tone; text: string }> = {
  admin: { tone: 'accent', text: 'Everything, including keys and users' },
  operator: { tone: 'blue', text: 'Runs anything on minions; no key or user management' },
  viewer: { tone: 'zinc', text: 'Read-only; no pillar access' },
  none: { tone: 'red', text: 'Cannot sign in (e.g. SSO users waiting for a role)' },
}

/** Local users get a synthetic email; anyone else came in through SSO. */
const isSso = (u: UserRow) => !u.email.endsWith('@users.salt-shaker.invalid')

export function UsersPage() {
  const { session, server } = useSession()
  const rolesFromIdp = !!server?.sso?.rolesFromIdp
  const list = useAsync(() => users.list(), [])
  const [creating, setCreating] = useState(false)
  const [resetFor, setResetFor] = useState<UserRow | null>(null)
  const [removing, setRemoving] = useState<UserRow | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<Error | null>(null)

  const act = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key)
    setError(null)
    try {
      await fn()
      await list.reload()
    } catch (e) {
      setError(e as Error)
    } finally {
      setBusy(null)
    }
  }

  const me = session?.user

  return (
    <>
      <PageHeader
        title="Users"
        description="Who can sign in to Salt Shaker and what their role allows. The master is reached through one service account; roles decide what each user may do through it."
        actions={
          <>
            <Button icon={<RefreshCw className="size-4" />} onClick={list.reload}>
              Refresh
            </Button>
            <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>
              Add user
            </Button>
          </>
        }
      />

      <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {ROLES.map((r) => (
          <Card key={r} className="p-4">
            <Badge tone={ROLE_INFO[r].tone}>{r}</Badge>
            <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">{ROLE_INFO[r].text}</p>
          </Card>
        ))}
      </div>

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
        {list.data && list.data.users.length === 0 && <Empty icon={<UsersIcon />} title="No users" />}
        {list.data && list.data.users.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-zinc-200 text-left text-xs text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
                  <th className="py-2.5 pr-3 pl-4 font-medium">User</th>
                  <th className="px-3 py-2.5 font-medium">Role</th>
                  <th className="hidden px-3 py-2.5 font-medium sm:table-cell">Last sign-in</th>
                  <th className="hidden px-3 py-2.5 font-medium md:table-cell">Created</th>
                  <th className="px-3 py-2.5 pr-4" />
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800/70">
                {list.data.users.map((u) => {
                  const isMe = u.username === me || u.name === me
                  return (
                    <tr key={u.id} className={u.banned ? 'opacity-60' : ''}>
                      <td className="py-2.5 pr-3 pl-4">
                        <p className="flex items-center gap-2 font-mono font-medium">
                          {u.username ?? u.name} {isMe && <span className="font-sans text-xs text-zinc-500 dark:text-zinc-400">(you)</span>}
                          {isSso(u) && <Badge tone="blue">{server?.sso?.name ?? 'SSO'}</Badge>}
                        </p>
                        {u.name !== u.username && <p className="text-xs text-zinc-500 dark:text-zinc-400">{u.name}</p>}
                      </td>
                      <td className="px-3 py-2.5">
                        <div className="flex items-center gap-2">
                          <Select
                            value={u.role ?? 'viewer'}
                            disabled={isMe || busy === `role:${u.id}` || (isSso(u) && rolesFromIdp)}
                            title={isSso(u) && rolesFromIdp ? `Set by ${server?.sso?.name} groups on every sign-in` : undefined}
                            onChange={(e) => act(`role:${u.id}`, () => users.setRole(u.id, e.target.value as Role))}
                            className="h-8 w-32"
                            aria-label={`Role of ${u.username ?? u.name}`}
                          >
                            {ROLES.map((r) => (
                              <option key={r}>{r}</option>
                            ))}
                          </Select>
                          {u.banned && <Badge tone="red">disabled</Badge>}
                        </div>
                      </td>
                      <td className="hidden px-3 py-2.5 text-zinc-500 sm:table-cell dark:text-zinc-400">
                        {u.lastSignInAt ? <span title={new Date(u.lastSignInAt).toLocaleString()}>{relTime(new Date(u.lastSignInAt))}</span> : 'never'}
                      </td>
                      <td className="hidden px-3 py-2.5 text-zinc-500 md:table-cell dark:text-zinc-400">{relTime(new Date(u.createdAt))}</td>
                      <td className="px-3 py-2.5 pr-4">
                        {!isMe && (
                          <div className="flex justify-end gap-1">
                            {!isSso(u) && (
                              <Button size="sm" variant="ghost" icon={<KeyRound className="size-3.5" />} onClick={() => setResetFor(u)}>
                                Password
                              </Button>
                            )}
                            {u.banned ? (
                              <Button size="sm" variant="ghost" icon={<Undo2 className="size-3.5" />} loading={busy === `ban:${u.id}`} onClick={() => act(`ban:${u.id}`, () => users.unban(u.id))}>
                                Enable
                              </Button>
                            ) : (
                              <Button size="sm" variant="ghost" icon={<Ban className="size-3.5" />} loading={busy === `ban:${u.id}`} onClick={() => act(`ban:${u.id}`, () => users.ban(u.id))}>
                                Disable
                              </Button>
                            )}
                            <Button size="sm" variant="ghost" icon={<Trash2 className="size-3.5" />} onClick={() => setRemoving(u)}>
                              Delete
                            </Button>
                          </div>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <CreateUserModal open={creating} onClose={() => setCreating(false)} onCreated={list.reload} />
      <ResetPasswordModal user={resetFor} onClose={() => setResetFor(null)} />
      <Modal open={!!removing} onClose={() => setRemoving(null)} title="Delete user?">
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          <span className="font-mono font-medium text-zinc-900 dark:text-zinc-100">{removing?.username ?? removing?.name}</span> will be signed out and removed. Their entries in the audit log
          stay.
        </p>
        <div className="mt-5 flex justify-end gap-2">
          <Button onClick={() => setRemoving(null)}>Cancel</Button>
          <Button
            variant="danger"
            icon={<Trash2 className="size-4" />}
            loading={busy === `rm:${removing?.id}`}
            onClick={async () => {
              await act(`rm:${removing!.id}`, () => users.remove(removing!.id))
              setRemoving(null)
            }}
          >
            Delete user
          </Button>
        </div>
      </Modal>
    </>
  )
}

function CreateUserModal({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: () => void }) {
  const [username, setUsername] = useState('')
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [role, setRole] = useState<Role>('viewer')
  const [error, setError] = useState<Error | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await users.create({ username: username.trim().toLowerCase(), name: name.trim(), password, role })
      onCreated()
      onClose()
      setUsername('')
      setName('')
      setPassword('')
    } catch (err) {
      setError(err as Error)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Add user">
      <form onSubmit={submit} className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Username">
            <Input value={username} onChange={(e) => setUsername(e.target.value)} pattern="[A-Za-z0-9][A-Za-z0-9._\-]{2,31}" required autoFocus />
          </Field>
          <Field label="Full name (optional)">
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
        </div>
        <Field label="Initial password" hint="At least 10 characters. Share it privately; the user can change it after signing in.">
          <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} minLength={10} autoComplete="new-password" required />
        </Field>
        <Field label="Role" hint={ROLE_INFO[role].text}>
          <Select value={role} onChange={(e) => setRole(e.target.value as Role)}>
            {ROLES.map((r) => (
              <option key={r}>{r}</option>
            ))}
          </Select>
        </Field>
        {error && <ErrorBox error={error} />}
        <div className="flex justify-end gap-2">
          <Button type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" loading={busy}>
            Create user
          </Button>
        </div>
      </form>
    </Modal>
  )
}

function ResetPasswordModal({ user, onClose }: { user: UserRow | null; onClose: () => void }) {
  const [password, setPassword] = useState('')
  const [error, setError] = useState<Error | null>(null)
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(false)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await users.setPassword(user!.id, password)
      setDone(true)
    } catch (err) {
      setError(err as Error)
    } finally {
      setBusy(false)
    }
  }

  const close = () => {
    setPassword('')
    setDone(false)
    setError(null)
    onClose()
  }

  return (
    <Modal open={!!user} onClose={close} title={`Set password for ${user?.username ?? user?.name}`}>
      {done ? (
        <div className="space-y-4 text-sm">
          <p>Password changed.</p>
          <div className="flex justify-end">
            <Button onClick={close}>Close</Button>
          </div>
        </div>
      ) : (
        <form onSubmit={submit} className="space-y-4">
          <Field label="New password" hint="At least 10 characters.">
            <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} minLength={10} autoComplete="new-password" required autoFocus />
          </Field>
          {error && <ErrorBox error={error} />}
          <div className="flex justify-end gap-2">
            <Button type="button" onClick={close}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" loading={busy}>
              Set password
            </Button>
          </div>
        </form>
      )}
    </Modal>
  )
}
