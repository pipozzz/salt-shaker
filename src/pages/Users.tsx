import { Ban, Check, Copy, Fingerprint, KeyRound, Link2, MailPlus, Pencil, RefreshCw, Trash2, Undo2, Users as UsersIcon } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { demoInvites, demoScopes, demoUsers } from '../api/demo-admin'
import { inviteLink, invites as serverInvites, ROLES, scopes as serverScopes, users as serverUsers, userSecurity, type Invite, type Role, type UserRow, type UserScope } from '../api/server'
import type { TargetType } from '../api/types'
import { TargetField } from '../components/TargetField'
import { Badge, Button, Card, CardHeader, Empty, ErrorBox, Field, Input, Modal, PageHeader, Select, Spinner, type Tone } from '../components/ui'
import { useAsync } from '../lib/hooks'
import { useSession } from '../lib/session'
import { relTime } from '../lib/format'
import { isLocalAccount, isUsername, USERNAME_RULE } from '../lib/username'

const ROLE_INFO: Record<Role, { tone: Tone; text: string }> = {
  admin: { tone: 'accent', text: 'Everything, including keys and users' },
  operator: { tone: 'blue', text: 'Runs anything on minions; no key or user management' },
  viewer: { tone: 'zinc', text: 'Read-only; no pillar access' },
  none: { tone: 'red', text: 'Cannot sign in (e.g. SSO users waiting for a role)' },
}

/** Local users get a synthetic email; anyone else came in through SSO. */
/** the server's accounts, or the demo's made-up team */
function useUsersApi() {
  const { session } = useSession()
  return session?.mode === 'demo' ? demoUsers : serverUsers
}

function useScopesApi() {
  const { session } = useSession()
  return session?.mode === 'demo' ? demoScopes : serverScopes
}

function useInvitesApi() {
  const { session } = useSession()
  return session?.mode === 'demo' ? demoInvites : serverInvites
}

const scopeText = (s: UserScope) => `${s.targetType === 'glob' ? '' : `${s.targetType}:`}${s.target}`

const isSso = (u: UserRow) => !isLocalAccount(u)

export function UsersPage() {
  const users = useUsersApi()
  const { session, server } = useSession()
  const rolesFromIdp = !!server?.sso?.rolesFromIdp
  const list = useAsync(() => users.list(), [])
  const scopesApi = useScopesApi()
  const scopeList = useAsync(() => scopesApi.list().then((r) => new Map(r.scopes.map((s) => [s.userId, s]))), [])
  const [limiting, setLimiting] = useState<UserRow | null>(null)
  // second steps and passkeys are the server's; the demo's made-up team has none
  const security = useAsync(() => (session?.mode === 'server' ? userSecurity.list().then((r) => r.users) : Promise.resolve({} as Awaited<ReturnType<typeof userSecurity.list>>['users'])), [])
  const [resetting, setResetting] = useState<UserRow | null>(null)
  const invitesApi = useInvitesApi()
  const inviteList = useAsync(() => invitesApi.list(), [])
  const [inviting, setInviting] = useState(false)
  // an invitation's link, right after it was made or replaced: it can't be read back later
  const [link, setLink] = useState<(Invite & { token: string }) | null>(null)
  const [revoking, setRevoking] = useState<Invite | null>(null)
  const [resetFor, setResetFor] = useState<UserRow | null>(null)
  const [removing, setRemoving] = useState<UserRow | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<Error | null>(null)

  const act = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key)
    setError(null)
    try {
      await fn()
      await Promise.all([list.reload(), scopeList.reload(), inviteList.reload(), security.reload()])
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
            <Button
              icon={<RefreshCw className="size-4" />}
              onClick={() => {
                list.reload()
                inviteList.reload()
              }}
            >
              Refresh
            </Button>
            <Button variant="primary" icon={<MailPlus className="size-4" />} onClick={() => setInviting(true)}>
              Invite user
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
                  <th className="px-3 py-2.5 font-medium" title="An admin can limit a user to the minions a target matches">
                    Can run on
                  </th>
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
                          {security.data?.[u.id]?.twoFactor && (
                            <Badge tone="green" title="Asked for a code from an authenticator app after the password">
                              2-step
                            </Badge>
                          )}
                          {!!security.data?.[u.id]?.passkeys && (
                            <Badge tone="green" title="Can sign in with a passkey">
                              <Fingerprint className="size-3" /> {security.data[u.id].passkeys}
                            </Badge>
                          )}
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
                      <td className="px-3 py-2.5">
                        {(() => {
                          const s = scopeList.data?.get(u.id)
                          if (u.role === 'admin') return <span className="text-xs text-zinc-500 dark:text-zinc-400">everything</span>
                          if (u.role === 'viewer' || u.role === 'none') return <span className="text-xs text-zinc-500 dark:text-zinc-400">—</span>
                          return (
                            <button
                              type="button"
                              onClick={() => setLimiting(u)}
                              className="inline-flex items-center gap-1.5 text-left text-xs hover:text-accent-700 dark:hover:text-accent-400"
                            >
                              {/* the visible text stays part of the name, for screen readers and voice control */}
                              <span className="sr-only">Change what {u.username ?? u.name} can run on: </span>
                              {s ? <Badge tone="amber" className="font-mono">{scopeText(s)}</Badge> : <span className="text-zinc-600 dark:text-zinc-400">whole fleet</span>}
                              <Pencil className="size-3 opacity-60" />
                            </button>
                          )
                        })()}
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
                            {security.data?.[u.id] && (
                              <Button size="sm" variant="ghost" icon={<Fingerprint className="size-3.5" />} title="Remove their second step and passkeys, e.g. after a lost phone" onClick={() => setResetting(u)}>
                                Reset sign-in
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

      {!!inviteList.data?.invites.length && (
        <Card className="mt-6">
          <CardHeader title="Invitations" />
          <ul className="divide-y divide-zinc-100 dark:divide-zinc-800/70">
            {inviteList.data.invites.map((i) => (
              <li key={i.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 text-sm">
                <div className="min-w-40 flex-1">
                  <p className="font-mono font-medium">{i.username}</p>
                  {i.name && <p className="text-xs text-zinc-500 dark:text-zinc-400">{i.name}</p>}
                </div>
                <span className="flex w-56 items-center gap-2">
                  <Badge tone={ROLE_INFO[i.role].tone}>{i.role}</Badge>
                  {i.scopeTarget && (
                    <Badge tone="amber" className="font-mono">
                      {scopeText({ target: i.scopeTarget, targetType: (i.scopeTargetType ?? 'glob') as TargetType })}
                    </Badge>
                  )}
                </span>
                <span className="w-56 text-xs text-zinc-500 dark:text-zinc-400">
                  {i.createdBy ? `by ${i.createdBy} · ` : ''}
                  {i.expired ? <Badge tone="red">expired</Badge> : <span title={new Date(i.expiresAt).toLocaleString()}>link valid until {new Date(i.expiresAt).toLocaleDateString()}</span>}
                </span>
                <div className="flex gap-1">
                  <Button
                    size="sm"
                    variant="ghost"
                    icon={<Link2 className="size-3.5" />}
                    loading={busy === `renew:${i.id}`}
                    title="The link can't be shown again: this makes a new one and the old one stops working"
                    onClick={() => act(`renew:${i.id}`, async () => setLink(await invitesApi.renew(i.id, 7)))}
                  >
                    New link
                  </Button>
                  <Button size="sm" variant="ghost" icon={<Trash2 className="size-3.5" />} onClick={() => setRevoking(i)}>
                    Revoke
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <InviteModal
        open={inviting}
        onClose={() => setInviting(false)}
        onInvited={(made) => {
          setLink(made)
          inviteList.reload()
        }}
      />
      {link && <InviteLinkModal invite={link} onClose={() => setLink(null)} />}
      <Modal open={!!revoking} onClose={() => setRevoking(null)} title="Revoke this invitation?">
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          The link for <span className="font-mono font-medium text-zinc-900 dark:text-zinc-100">{revoking?.username}</span> stops working and no account is created.
        </p>
        <div className="mt-5 flex justify-end gap-2">
          <Button onClick={() => setRevoking(null)}>Cancel</Button>
          <Button
            variant="danger"
            loading={busy === `revoke:${revoking?.id}`}
            onClick={async () => {
              await act(`revoke:${revoking!.id}`, () => invitesApi.revoke(revoking!.id))
              setRevoking(null)
            }}
          >
            Revoke
          </Button>
        </div>
      </Modal>
      <ResetPasswordModal user={resetFor} onClose={() => setResetFor(null)} />
      {limiting && (
        <ScopeModal
          user={limiting}
          current={scopeList.data?.get(limiting.id) ?? null}
          onClose={() => setLimiting(null)}
          onSave={(s) => act(`scope:${limiting.id}`, () => (s ? scopesApi.set(limiting.id, s) : scopesApi.clear(limiting.id))).then(() => setLimiting(null))}
        />
      )}
      <Modal open={!!resetting} onClose={() => setResetting(null)} title="Reset how this user signs in?">
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          For a lost phone or security key: <span className="font-mono font-medium text-zinc-900 dark:text-zinc-100">{resetting?.username ?? resetting?.name}</span> loses their two-step verification and
          passkeys and is signed out everywhere. Their password still works, and they can set both up again.
        </p>
        <div className="mt-5 flex justify-end gap-2">
          <Button onClick={() => setResetting(null)}>Cancel</Button>
          <Button
            variant="danger"
            loading={busy === `reset:${resetting?.id}`}
            onClick={async () => {
              await act(`reset:${resetting!.id}`, () => userSecurity.reset(resetting!.id))
              setResetting(null)
            }}
          >
            Reset sign-in
          </Button>
        </div>
      </Modal>
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

const INVITE_DAYS = [
  { days: 1, label: '1 day' },
  { days: 7, label: '7 days' },
  { days: 30, label: '30 days' },
]

/** Who to invite and as what; the password is theirs to choose when they open the link. */
function InviteModal({ open, onClose, onInvited }: { open: boolean; onClose: () => void; onInvited: (made: Invite & { token: string }) => void }) {
  const invites = useInvitesApi()
  const { server } = useSession()
  const [username, setUsername] = useState('')
  const [name, setName] = useState('')
  const [role, setRole] = useState<Role>('viewer')
  const [days, setDays] = useState(7)
  const [limited, setLimited] = useState(false)
  const [tgt, setTgt] = useState('')
  const [tgtType, setTgtType] = useState<TargetType>('glob')
  const [error, setError] = useState<Error | null>(null)
  const [busy, setBusy] = useState(false)
  // with PASSWORD_LOGIN=admins, everyone else comes in through SSO and needs no invitation
  const adminsOnly = !!server?.sso && server.passwordLogin === 'admins'
  const scoped = role === 'operator' && limited

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!isUsername(username)) return setError(new Error(`Username: ${USERNAME_RULE}`))
    setBusy(true)
    setError(null)
    try {
      const made = await invites.create({ username: username.trim().toLowerCase(), name: name.trim(), role, days, scope: scoped ? { target: tgt.trim(), targetType: tgtType } : null })
      onClose()
      onInvited(made)
      setUsername('')
      setName('')
      setLimited(false)
      setTgt('')
    } catch (err) {
      setError(err as Error)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Invite user">
      <form onSubmit={submit} className="space-y-4">
        <p className="text-sm text-zinc-600 dark:text-zinc-400">You get a link to send them. They open it, choose their own password and are signed in; nobody else ever knows it.</p>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Username" hint="A short name, or an email address">
            <Input value={username} onChange={(e) => setUsername(e.target.value.trim())} required autoFocus aria-invalid={!!username && !isUsername(username)} />
          </Field>
          <Field label="Full name (optional)">
            <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={100} />
          </Field>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Role" hint={adminsOnly && role !== 'admin' ? `Only admins sign in with a password here; others use ${server?.sso?.name}.` : ROLE_INFO[role].text}>
            <Select value={role} onChange={(e) => setRole(e.target.value as Role)}>
              {ROLES.filter((r) => r !== 'none').map((r) => (
                <option key={r}>{r}</option>
              ))}
            </Select>
          </Field>
          <Field label="Link valid for">
            <Select value={days} onChange={(e) => setDays(Number(e.target.value))}>
              {INVITE_DAYS.map((d) => (
                <option key={d.days} value={d.days}>
                  {d.label}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        {role === 'operator' && (
          <div className="space-y-3">
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={limited} onChange={(e) => setLimited(e.target.checked)} className="size-4 rounded border-zinc-300 accent-accent-600" />
              Limit what they can run on
            </label>
            {limited && (
              <TargetField
                tgt={tgt}
                tgtType={tgtType}
                onChange={(t, tt) => {
                  setTgt(t)
                  setTgtType(tt)
                }}
              />
            )}
          </div>
        )}
        {error && <ErrorBox error={error} />}
        <div className="flex justify-end gap-2">
          <Button type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" icon={<Link2 className="size-4" />} loading={busy} disabled={(adminsOnly && role !== 'admin') || (scoped && !tgt.trim())}>
            Create invite link
          </Button>
        </div>
      </form>
    </Modal>
  )
}

/** The link, once: only its hash is kept on the server. */
function InviteLinkModal({ invite, onClose }: { invite: Invite & { token: string }; onClose: () => void }) {
  const [copied, setCopied] = useState(false)
  const url = inviteLink(invite.token)
  return (
    <Modal open onClose={onClose} title={`Invite link for ${invite.username}`} wide>
      <div className="space-y-3 text-sm">
        <p className="text-zinc-600 dark:text-zinc-400">
          Send this link to {invite.name || invite.username} over a channel you trust. It works once, until {new Date(invite.expiresAt).toLocaleString()}, and isn't shown again: if it gets lost, make a new
          link from the list of invitations.
        </p>
        <div className="flex items-center gap-2">
          <code className="min-w-0 flex-1 rounded-lg bg-zinc-100 px-3 py-2 font-mono text-xs break-all select-all dark:bg-zinc-800" aria-label="Invite link">
            {url}
          </code>
          <Button
            size="sm"
            icon={copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
            onClick={() =>
              void navigator.clipboard
                .writeText(url)
                .then(() => setCopied(true))
                .catch(() => undefined)
            }
          >
            {copied ? 'Copied' : 'Copy'}
          </Button>
        </div>
        <div className="flex justify-end">
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        </div>
      </div>
    </Modal>
  )
}

function ResetPasswordModal({ user, onClose }: { user: UserRow | null; onClose: () => void }) {
  const users = useUsersApi()
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

/** Limits a user to the minions a target matches, or lifts the limit. */
function ScopeModal({ user, current, onClose, onSave }: { user: UserRow; current: UserScope | null; onClose: () => void; onSave: (s: UserScope | null) => void }) {
  const [tgt, setTgt] = useState(current?.target ?? '')
  const [tgtType, setTgtType] = useState<TargetType>((current?.targetType as TargetType) ?? 'glob')
  const name = user.username ?? user.name
  return (
    <Modal open onClose={onClose} title={`What ${name} can run on`}>
      <div className="space-y-4 text-sm">
        <p className="text-zinc-600 dark:text-zinc-400">
          Every command, state run and query {name} starts is checked against this target on the server, and runs only on the minions it matches. Anything that would reach other minions is refused and recorded in the audit log, and so are runners that change something, such as orchestrations.
        </p>
        <TargetField
          tgt={tgt}
          tgtType={tgtType}
          onChange={(t, tt) => {
            setTgt(t)
            setTgtType(tt)
          }}
        />
        <div className="flex flex-wrap justify-end gap-2">
          {current && (
            <Button className="mr-auto" onClick={() => onSave(null)}>
              Whole fleet
            </Button>
          )}
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!tgt.trim()} onClick={() => onSave({ target: tgt.trim(), targetType: tgtType })}>
            Limit to this target
          </Button>
        </div>
      </div>
    </Modal>
  )
}

