import clsx from 'clsx'
import { ArrowLeft, Check, CircleSlash, GitPullRequestArrow, RefreshCw, Square, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import type { Change, MinionOutcome } from '../api/server'
import { formatArgs } from '../api/salt'
import { Badge, Button, Card, CardHeader, Empty, ErrorBox, Modal, PageHeader, Spinner } from '../components/ui'
import { WindowNotice } from '../components/Windows'
import { CHANGE_STATUS, changeTarget, useChangesApi } from '../lib/changes'
import { relTime } from '../lib/format'
import { useAsync } from '../lib/hooks'
import { useSession } from '../lib/session'

const ACTIVE = ['pending', 'queued', 'running']
const callText = (c: Change) => `${c.fun} ${formatArgs([...c.args.arg, ...(Object.keys(c.args.kwarg).length ? [{ __kwarg__: true, ...c.args.kwarg }] : [])])}`.trim()

/** Every change: what waits for approval, what's rolling out, and what ran before. */
export function ChangesPage() {
  const api = useChangesApi()
  const [reloads, setReloads] = useState(0)
  const list = useAsync(() => (api ? api.list() : Promise.resolve(null)), [api, reloads])
  // a rollout moves on its own; keep up while one is running
  const active = list.data?.changes.some((c) => c.status === 'queued' || c.status === 'running')
  useEffect(() => {
    if (!active) return
    const t = setTimeout(() => setReloads((n) => n + 1), 3000)
    return () => clearTimeout(t)
  }, [active, list.data])

  const all = list.data?.changes ?? []
  const waiting = all.filter((c) => c.status === 'pending')
  return (
    <>
      <PageHeader
        title="Changes"
        description="Commands rolled out in batches, stopped when too many minions fail, and approved first when the policy asks for it. Start one from Run."
        actions={
          <Button icon={<RefreshCw className={clsx('size-4', list.loading && 'animate-spin')} />} onClick={() => setReloads((n) => n + 1)}>
            Refresh
          </Button>
        }
      />
      <WindowNotice className="mb-4" />
      {list.error && <ErrorBox error={list.error} onRetry={() => setReloads((n) => n + 1)} />}
      {list.data?.approval === 'risky' && (
        <p className="mb-4 text-sm text-zinc-600 dark:text-zinc-400">Operators' commands that change minions need an admin's approval here before they run; another admin than the requester decides.</p>
      )}
      {waiting.length > 0 && (
        <Card className="mb-6">
          <CardHeader title={`Waiting for approval (${waiting.length})`} />
          <ChangeList list={waiting} />
        </Card>
      )}
      <Card>
        <CardHeader title="All changes" />
        {!list.data && list.loading ? (
          <Spinner />
        ) : all.length === 0 ? (
          <Empty icon={<GitPullRequestArrow />} title="No changes yet">
            On{' '}
            <Link to="/run" className="text-accent-700 underline underline-offset-2 hover:text-accent-800 dark:text-accent-400 dark:hover:text-accent-100">
              Run
            </Link>
            , tick <em>Roll out in batches</em> to start one.
          </Empty>
        ) : (
          <ChangeList list={all} />
        )}
      </Card>
    </>
  )
}

function ChangeList({ list }: { list: Change[] }) {
  return (
    <ul className="divide-y divide-zinc-100 dark:divide-zinc-800/70">
      {list.map((c) => {
        const s = CHANGE_STATUS[c.status]
        const done = c.batches.reduce((n, b) => n + b.minions.length, 0)
        return (
          <li key={c.id}>
            <Link to={`/changes/${c.id}`} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 hover:bg-zinc-50 dark:hover:bg-zinc-800/30">
              <span className="w-10 font-mono text-xs text-zinc-500 dark:text-zinc-400">#{c.id}</span>
              <div className="min-w-48 flex-1">
                <p className="truncate font-mono text-sm font-medium">
                  {c.fun} <span className="text-zinc-500 dark:text-zinc-400">→ {changeTarget(c)}</span>
                </p>
                <p className="truncate text-xs text-zinc-600 dark:text-zinc-400">{c.reason}</p>
              </div>
              <Badge tone={s.tone}>{s.label}</Badge>
              <span className="w-28 text-xs text-zinc-500 dark:text-zinc-400">
                {c.minions ? `${done}/${c.minions.length} started` : c.batchSize ? `batches of ${c.batchSize}` : 'all at once'}
              </span>
              <span className="w-36 text-xs text-zinc-500 dark:text-zinc-400">
                {c.requestedBy}, {relTime(new Date(c.requestedAt))}
              </span>
            </Link>
          </li>
        )
      })}
    </ul>
  )
}

const OUTCOME: Record<MinionOutcome, { label: string; cls: string }> = {
  ok: { label: 'ok', cls: 'bg-emerald-50 text-emerald-800 ring-emerald-200 dark:bg-emerald-950/60 dark:text-emerald-300 dark:ring-emerald-900' },
  failed: { label: 'failed', cls: 'bg-red-50 text-red-800 ring-red-200 dark:bg-red-950/60 dark:text-red-300 dark:ring-red-900' },
  running: { label: 'running', cls: 'bg-sky-50 text-sky-800 ring-sky-200 dark:bg-sky-950/60 dark:text-sky-300 dark:ring-sky-900' },
  waiting: { label: 'waiting', cls: 'bg-zinc-50 text-zinc-600 ring-zinc-200 dark:bg-zinc-900 dark:text-zinc-400 dark:ring-zinc-700' },
}

/** One change: why, what it runs, its batches and each minion's outcome; approve, reject or stop it. */
export function ChangeDetailPage() {
  const id = Number(useParams().id)
  const api = useChangesApi()
  const { session } = useSession()
  const [reloads, setReloads] = useState(0)
  const { data, error, loading } = useAsync(() => (api ? api.get(id) : Promise.reject(new Error('Changes need the server'))), [api, id, reloads])
  const c = data?.change
  useEffect(() => {
    if (!c || !(c.status === 'queued' || c.status === 'running')) return
    const t = setTimeout(() => setReloads((n) => n + 1), 2000)
    return () => clearTimeout(t)
  }, [c, data])
  const [busy, setBusy] = useState<string | null>(null)
  const [actionError, setActionError] = useState<Error | null>(null)
  const [rejecting, setRejecting] = useState(false)
  const [note, setNote] = useState('')

  const act = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key)
    setActionError(null)
    try {
      await fn()
      setReloads((n) => n + 1)
    } catch (e) {
      setActionError(e as Error)
    } finally {
      setBusy(null)
    }
  }

  if (error) return <ErrorBox error={error} />
  if (!c) return loading ? <Spinner /> : null
  const me = session?.user
  const isAdmin = session?.mode === 'demo' || session?.eauth === 'admin'
  const mine = c.requestedBy === me
  const canDecide = c.status === 'pending' && isAdmin && !mine
  const canStop = ACTIVE.includes(c.status) && (isAdmin || mine)
  const outcome = data.outcome
  const counts = Object.values(outcome).reduce<Record<MinionOutcome, number>>((n, o) => ({ ...n, [o]: n[o] + 1 }), { ok: 0, failed: 0, running: 0, waiting: 0 })
  const s = CHANGE_STATUS[c.status]

  return (
    <>
      <Link to="/changes" className="mb-4 inline-flex items-center gap-1 text-sm text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200">
        <ArrowLeft className="size-4" /> Changes
      </Link>
      <PageHeader
        title={`Change #${c.id}`}
        description={c.reason}
        actions={
          <>
            {canDecide && (
              <>
                <Button variant="success" icon={<Check className="size-4" />} loading={busy === 'approve'} onClick={() => act('approve', () => api!.approve(c.id))}>
                  Approve
                </Button>
                <Button icon={<X className="size-4" />} onClick={() => setRejecting(true)}>
                  Reject…
                </Button>
              </>
            )}
            {canStop && (
              <Button variant="danger" icon={<Square className="size-4" />} loading={busy === 'stop'} onClick={() => act('stop', () => api!.stop(c.id))}>
                Stop
              </Button>
            )}
          </>
        }
      />
      {actionError && (
        <div className="mb-4">
          <ErrorBox error={actionError} />
        </div>
      )}
      {c.status === 'pending' && mine && <p className="mb-4 text-sm text-amber-700 dark:text-amber-400">Waiting for another admin to approve it.</p>}

      <div className="mb-6 grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title="What" actions={<Badge tone={s.tone}>{s.label}</Badge>} />
          <dl className="grid grid-cols-[8rem_1fr] gap-x-3 gap-y-2 p-4 text-sm">
            <dt className="text-zinc-500 dark:text-zinc-400">Runs</dt>
            <dd className="font-mono break-all">{callText(c)}</dd>
            <dt className="text-zinc-500 dark:text-zinc-400">On</dt>
            <dd className="font-mono">{changeTarget(c)}</dd>
            <dt className="text-zinc-500 dark:text-zinc-400">Batches</dt>
            <dd>{c.batchSize ? `${c.batchSize} at a time` : 'all at once'}, stop after {c.maxFailures === 0 ? 'the first failure' : `${c.maxFailures + 1} failures`}</dd>
            <dt className="text-zinc-500 dark:text-zinc-400">Requested</dt>
            <dd>
              by {c.requestedBy}, {relTime(new Date(c.requestedAt))}
            </dd>
            {c.decidedBy && (
              <>
                <dt className="text-zinc-500 dark:text-zinc-400">{c.status === 'rejected' ? 'Rejected' : 'Approved'}</dt>
                <dd>
                  by {c.decidedBy}, {relTime(new Date(c.decidedAt!))}
                  {c.decisionNote && <span className="text-zinc-600 dark:text-zinc-400">: “{c.decisionNote}”</span>}
                </dd>
              </>
            )}
            {c.error && (
              <>
                <dt className="text-zinc-500 dark:text-zinc-400">{c.status === 'done' ? 'Note' : 'Why it ended'}</dt>
                <dd className={c.status === 'done' ? '' : 'text-red-700 dark:text-red-400'}>{c.error}</dd>
              </>
            )}
          </dl>
        </Card>

        <Card>
          <CardHeader title="Batches" subtitle={c.minions ? `${c.minions.length} minions` : 'The minions are worked out when it starts'} />
          {c.batches.length === 0 ? (
            <p className="p-4 text-sm text-zinc-500 dark:text-zinc-400">{c.status === 'pending' ? 'Nothing runs until it is approved.' : 'None started.'}</p>
          ) : (
            <ol className="divide-y divide-zinc-100 text-sm dark:divide-zinc-800/70">
              {c.batches.map((b, i) => {
                const failed = b.minions.filter((m) => outcome[m] === 'failed').length
                const ok = b.minions.filter((m) => outcome[m] === 'ok').length
                return (
                  <li key={i} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2">
                    <span className="w-16 text-xs text-zinc-500 dark:text-zinc-400">Batch {i + 1}</span>
                    <span className="min-w-0 flex-1 truncate font-mono text-xs">{b.minions.join(', ')}</span>
                    <span className="text-xs text-zinc-600 dark:text-zinc-400">
                      {ok} ok{failed ? ` · ${failed} failed` : ''}
                    </span>
                    {b.jid && (
                      <Link to={`/jobs/${b.jid}`} className="font-mono text-xs text-accent-700 underline underline-offset-2 hover:text-accent-800 dark:text-accent-400 dark:hover:text-accent-100">
                        job
                      </Link>
                    )}
                  </li>
                )
              })}
            </ol>
          )}
        </Card>
      </div>

      {c.minions && (
        <Card>
          <CardHeader
            title="Minions"
            subtitle={(['ok', 'failed', 'running', 'waiting'] as const)
              .filter((k) => counts[k])
              .map((k) => `${counts[k]} ${OUTCOME[k].label}`)
              .join(' · ')}
          />
          <ul className="flex flex-wrap gap-1.5 p-4">
            {c.minions.map((m) => (
              <li key={m}>
                <Link to={`/minions/${encodeURIComponent(m)}`} className={clsx('inline-flex items-center gap-1.5 rounded-md px-2 py-1 font-mono text-xs ring-1 ring-inset', OUTCOME[outcome[m] ?? 'waiting'].cls)} title={OUTCOME[outcome[m] ?? 'waiting'].label}>
                  {m}
                  <span className="sr-only">: {OUTCOME[outcome[m] ?? 'waiting'].label}</span>
                  {outcome[m] === 'failed' && <CircleSlash className="size-3" />}
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Modal open={rejecting} onClose={() => setRejecting(false)} title={`Reject change #${c.id}?`}>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            void act('reject', () => api!.reject(c.id, note.trim())).then(() => setRejecting(false))
          }}
          className="space-y-3 text-sm"
        >
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-zinc-600 dark:text-zinc-400">Why (the requester sees it)</span>
            <textarea value={note} onChange={(e) => setNote(e.target.value)} required rows={3} className="w-full rounded-lg border border-zinc-200 bg-white p-2 text-sm focus:border-accent-500 focus:outline-none dark:border-zinc-800 dark:bg-zinc-900" />
          </label>
          <div className="flex justify-end gap-2">
            <Button type="button" onClick={() => setRejecting(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="danger" disabled={!note.trim()} loading={busy === 'reject'}>
              Reject
            </Button>
          </div>
        </form>
      </Modal>
    </>
  )
}
