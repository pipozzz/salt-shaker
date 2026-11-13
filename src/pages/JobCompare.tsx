import clsx from 'clsx'
import { ArrowLeft, ArrowLeftRight, ChevronRight, GitCompare } from 'lucide-react'
import { useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { formatArgs } from '../api/salt'
import { history, parseStoredArgs } from '../api/server'
import type { JobDetail } from '../api/types'
import { Badge, Button, Card, Empty, ErrorBox, Modal, PageHeader, Spinner, type Tone } from '../components/ui'
import { funTone, relTime } from '../lib/format'
import { useAsync } from '../lib/hooks'
import { compareJobs, type Detail, type MinionCompare, type Outcome, type StateOutcome } from '../lib/job-compare'
import { jobResults, loadJobDetail } from '../lib/job-detail'
import { useSalt, useSession } from '../lib/session'

const OUTCOME: Record<Outcome, { tone: Tone; label: string }> = {
  ok: { tone: 'green', label: 'ok' },
  changed: { tone: 'blue', label: 'changed' },
  pending: { tone: 'amber', label: 'would change' },
  failed: { tone: 'red', label: 'failed' },
  missing: { tone: 'zinc', label: 'no return' },
  absent: { tone: 'zinc', label: 'not targeted' },
}

function OutcomeBadge({ o }: { o: Outcome | StateOutcome | null }) {
  if (!o) return <Badge>not there</Badge>
  return <Badge tone={OUTCOME[o].tone}>{OUTCOME[o].label}</Badge>
}

const targetOf = (j: JobDetail) => {
  const t = Array.isArray(j.Target) ? j.Target.join(',') : j.Target
  return `${j['Target-type'] && j['Target-type'] !== 'glob' ? `${j['Target-type']}:` : ''}${t}`
}

/** Two jobs, minion by minion: how each ended, and what it returned differently. */
export function JobComparePage() {
  const salt = useSalt()
  const navigate = useNavigate()
  const { session } = useSession()
  const fromServer = session?.mode === 'server'
  const [params] = useSearchParams()
  const a = params.get('a') ?? ''
  const b = params.get('b') ?? ''
  const { data, error, loading, reload } = useAsync(
    () => (a && b ? Promise.all([loadJobDetail(salt, fromServer, a), loadJobDetail(salt, fromServer, b)]) : Promise.resolve(null)),
    [salt, fromServer, a, b],
  )
  const [showSame, setShowSame] = useState(false)

  const rows = data ? compareJobs({ results: jobResults(data[0]), minions: data[0].Minions ?? [] }, { results: jobResults(data[1]), minions: data[1].Minions ?? [] }) : []
  const differ = rows.filter((r) => r.differs)
  const shown = showSame ? rows : differ
  const sameCommand = data && data[0].Function === data[1].Function && formatArgs(data[0].Arguments) === formatArgs(data[1].Arguments)

  return (
    <>
      <Link to={b ? `/jobs/${b}` : '/jobs'} className="mb-4 inline-flex items-center gap-1 text-sm text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200">
        <ArrowLeft className="size-4" /> {b ? 'Job' : 'Jobs'}
      </Link>
      <PageHeader
        title="Compare jobs"
        description="How each minion ended in two runs, and what it returned differently."
        actions={
          a && b ? (
            <Button icon={<ArrowLeftRight className="size-4" />} onClick={() => navigate(`/jobs/compare?${new URLSearchParams({ a: b, b: a })}`, { replace: true })}>
              Swap
            </Button>
          ) : undefined
        }
      />
      {!(a && b) && <Empty icon={<GitCompare />} title="Pick two jobs">Open a job and click Compare with… to pick the other one.</Empty>}
      {error && <ErrorBox error={error} onRetry={reload} />}
      {loading && !data && a && b && <Spinner label="Loading both jobs…" />}
      {data && (
        <>
          <div className="mb-4 grid gap-3 sm:grid-cols-2">
            {data.map((j, i) => (
              <Card key={j.jid} className="p-4">
                <p className="mb-2 text-xs font-medium text-zinc-500 uppercase dark:text-zinc-400">{i === 0 ? 'A' : 'B'}</p>
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={funTone(j.Function)} className="font-mono">
                    {j.Function}
                  </Badge>
                  <span className="font-mono text-xs text-zinc-600 dark:text-zinc-400">{formatArgs(j.Arguments)}</span>
                </div>
                <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
                  <dt className="text-zinc-500 dark:text-zinc-400">Target</dt>
                  <dd className="truncate font-mono text-xs leading-5">{targetOf(j)}</dd>
                  <dt className="text-zinc-500 dark:text-zinc-400">Started</dt>
                  <dd>{salt.jidDate(j.jid)?.toLocaleString() ?? j.StartTime}</dd>
                  <dt className="text-zinc-500 dark:text-zinc-400">By</dt>
                  <dd>{j.User || '—'}</dd>
                </dl>
                <Link to={`/jobs/${j.jid}`} className="mt-2 inline-block font-mono text-xs text-accent-700 hover:underline dark:text-accent-400">
                  jid {j.jid}
                </Link>
              </Card>
            ))}
          </div>
          {!sameCommand && <p className="mb-4 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">These ran different commands, so expect them to differ; minions are still lined up one by one.</p>}

          <Card>
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-200 px-4 py-3 text-sm dark:border-zinc-800">
              <span className="font-medium">
                {differ.length === 0 ? 'Every minion ended the same way and returned the same' : `${differ.length} of ${rows.length} ${rows.length === 1 ? 'minion differs' : 'minions differ'}`}
              </span>
              {rows.length > differ.length && differ.length > 0 && (
                <label className="flex items-center gap-2 text-zinc-600 dark:text-zinc-400">
                  <input type="checkbox" checked={showSame} onChange={(e) => setShowSame(e.target.checked)} className="accent-accent-600" />
                  Show the {rows.length - differ.length} that are the same
                </label>
              )}
            </div>
            {(differ.length === 0 ? rows : shown).length > 0 && (
              <ul className="divide-y divide-zinc-100 dark:divide-zinc-800/70">
                {(differ.length === 0 ? rows : shown).map((r) => (
                  <MinionRow key={r.id} r={r} />
                ))}
              </ul>
            )}
          </Card>
        </>
      )}
    </>
  )
}

function MinionRow({ r }: { r: MinionCompare }) {
  const hasDetail = r.detail.kind !== 'none'
  const [open, setOpen] = useState(r.differs && hasDetail)
  return (
    <li aria-label={r.id}>
      <button type="button" disabled={!hasDetail} onClick={() => setOpen(!open)} aria-expanded={hasDetail ? open : undefined} className="flex w-full flex-wrap items-center gap-3 px-4 py-2.5 text-left text-sm enabled:hover:bg-zinc-50 dark:enabled:hover:bg-zinc-800/30">
        <ChevronRight className={clsx('size-4 shrink-0 text-zinc-400 transition', open && 'rotate-90', !hasDetail && 'invisible')} />
        <span className="min-w-32 font-mono font-medium">{r.id}</span>
        <span className="flex items-center gap-1.5">
          <OutcomeBadge o={r.a} />
          <span className="text-zinc-400">→</span>
          <OutcomeBadge o={r.b} />
        </span>
        {!r.differs && <span className="text-xs text-zinc-500 dark:text-zinc-400">same</span>}
      </button>
      {open && hasDetail && (
        <div className="px-4 pb-3 pl-11">
          <DetailView d={r.detail} />
        </div>
      )}
    </li>
  )
}

function DetailView({ d }: { d: Detail }) {
  if (d.kind === 'states')
    return d.differ.length ? (
      <div className="overflow-x-auto">
        <table className="w-full table-fixed text-sm">
          <thead>
            <tr className="text-left text-xs text-zinc-500 dark:text-zinc-400">
              <th className="w-2/5 py-1.5 pr-3 font-medium">State</th>
              <th className="px-3 py-1.5 font-medium">A</th>
              <th className="px-3 py-1.5 font-medium">B</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800/70">
            {d.differ.map((s) => (
              <tr key={s.key} className="align-top">
                <td className="py-1.5 pr-3 font-mono text-xs break-all">{s.label}</td>
                <td className="px-3 py-1.5">
                  <OutcomeBadge o={s.a} />
                  {s.aComment && <p className="mt-1 max-w-sm text-xs text-zinc-500 dark:text-zinc-400">{s.aComment}</p>}
                </td>
                <td className="px-3 py-1.5">
                  <OutcomeBadge o={s.b} />
                  {s.bComment && <p className="mt-1 max-w-sm text-xs text-zinc-500 dark:text-zinc-400">{s.bComment}</p>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {d.same > 0 && <p className="mt-1.5 text-xs text-zinc-500 dark:text-zinc-400">{d.same === 1 ? '1 other state ended the same' : `${d.same} other states ended the same`}</p>}
      </div>
    ) : (
      <p className="text-sm text-zinc-500 dark:text-zinc-400">Every state ended the same.</p>
    )
  if (d.kind === 'values')
    return (
      <div className="overflow-x-auto">
        <table className="w-full table-fixed text-sm">
          <thead>
            <tr className="text-left text-xs text-zinc-500 dark:text-zinc-400">
              <th className="w-2/5 py-1.5 pr-3 font-medium">Key</th>
              <th className="px-3 py-1.5 font-medium">A</th>
              <th className="px-3 py-1.5 font-medium">B</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100 font-mono text-xs dark:divide-zinc-800/70">
            {d.differ.map((v) => (
              <tr key={v.key}>
                <td className="py-1.5 pr-3 break-all">{v.key}</td>
                <td className="px-3 py-1.5 break-all text-red-700 dark:text-red-400">{v.a ?? '—'}</td>
                <td className="px-3 py-1.5 break-all text-emerald-700 dark:text-emerald-400">{v.b ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {d.same > 0 && <p className="mt-1.5 text-xs text-zinc-500 dark:text-zinc-400">{d.same === 1 ? '1 other value is the same' : `${d.same} other values are the same`}</p>}
      </div>
    )
  if (d.kind === 'text')
    return (
      <pre className="max-h-96 overflow-auto rounded-lg bg-zinc-50 p-2 font-mono text-xs dark:bg-zinc-950">
        {d.lines.map((l, i) => (
          <div key={i} className={clsx(l.kind === 'add' && 'bg-emerald-50 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300', l.kind === 'del' && 'bg-red-50 text-red-800 dark:bg-red-950/40 dark:text-red-300')}>
            {l.kind === 'add' ? '+ ' : l.kind === 'del' ? '- ' : '  '}
            {l.text}
          </div>
        ))}
      </pre>
    )
  return null
}

interface Candidate {
  jid: string
  args: string
  target: string
  user: string
  date: Date | null
}

/** Other runs of a job's function, newest first, to compare it with. */
export function CompareWithModal({ job, onClose }: { job: JobDetail; onClose: () => void }) {
  const salt = useSalt()
  const navigate = useNavigate()
  const { session } = useSession()
  const fromServer = session?.mode === 'server'
  const args = formatArgs(job.Arguments)
  const { data, error, loading, reload } = useAsync(async (): Promise<Candidate[]> => {
    if (fromServer) {
      const { rows } = await history.jobs({ q: job.Function, limit: 100 })
      return rows
        .filter((r) => r.fun === job.Function && r.jid !== job.jid)
        .map((r) => ({ jid: r.jid, args: formatArgs(parseStoredArgs(r.args)), target: `${r.targetType && r.targetType !== 'glob' ? `${r.targetType}:` : ''}${r.target ?? ''}`, user: r.shakerUser ?? r.saltUser ?? '', date: new Date(r.startedAt) }))
    }
    const all = await salt.listJobs()
    return Object.entries(all)
      .filter(([jid, j]) => j.Function === job.Function && jid !== job.jid)
      .sort(([x], [y]) => y.localeCompare(x))
      .slice(0, 100)
      .map(([jid, j]) => ({ jid, args: formatArgs(j.Arguments), target: targetOf({ ...j, jid }), user: j.User, date: salt.jidDate(jid) }))
  }, [salt, fromServer, job.jid, job.Function])
  // the same arguments first: those are the runs worth comparing
  const sorted = [...(data ?? [])].sort((x, y) => Number(y.args === args) - Number(x.args === args))
  const pick = (other: Candidate) => {
    // the older one on the left
    const [a, b] = other.jid < job.jid ? [other.jid, job.jid] : [job.jid, other.jid]
    navigate(`/jobs/compare?${new URLSearchParams({ a, b })}`)
  }
  return (
    <Modal open onClose={onClose} title={`Compare with another ${job.Function}`} wide>
      {error && <ErrorBox error={error} onRetry={reload} />}
      {loading && !data && <Spinner />}
      {data && !sorted.length && <p className="text-sm text-zinc-500 dark:text-zinc-400">No other {job.Function} job is kept to compare with.</p>}
      {sorted.length > 0 && (
        <ul className="-mx-2 max-h-[60vh] divide-y divide-zinc-100 overflow-y-auto dark:divide-zinc-800/70">
          {sorted.map((c) => (
            <li key={c.jid}>
              <button type="button" onClick={() => pick(c)} className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 rounded-lg px-2 py-2 text-left text-sm hover:bg-zinc-50 dark:hover:bg-zinc-800/40">
                <span className="font-mono text-xs">{c.args || <span className="text-zinc-400">no arguments</span>}</span>
                <span className="font-mono text-xs text-zinc-500 dark:text-zinc-400">on {c.target}</span>
                <span className="ml-auto text-xs text-zinc-500 dark:text-zinc-400" title={c.date?.toLocaleString()}>
                  {c.date ? relTime(c.date) : c.jid}
                  {c.user && ` · ${c.user}`}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  )
}
