import clsx from 'clsx'
import { ArrowLeft, Download, Gauge, Play, ShieldCheck, ShieldX, Unplug } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import type { TargetType } from '../api/types'
import { TargetField } from '../components/TargetField'
import { Badge, Button, Card, CardHeader, Empty, ErrorBox, PageHeader, PermNote, Spinner, Stat } from '../components/ui'
import { download } from '../lib/export'
import { CHECKS, evidenceCsv, hardeningSql, summarize } from '../lib/hardening'
import { useStoredState } from '../lib/hooks'
import { osqueryCall } from '../lib/osquery'
import { useCan } from '../lib/session'
import { useJob } from '../lib/useJob'

const scoreTone = (s: number) => (s >= 90 ? 'green' : s >= 70 ? 'amber' : 'red')

/** Common hardening checks on the fleet with osquery: a score per minion, who fails what, and evidence to keep. */
export function HardeningPage() {
  const can = useCan()
  const canRun = can('local', 'cmd.run')
  const job = useJob()
  const [tgt, setTgt] = useStoredState('salt-shaker.hardening.tgt', '*')
  const [tgtType, setTgtType] = useStoredState<TargetType>('salt-shaker.hardening.tgtType', 'glob')
  const [error, setError] = useState<Error | null>(null)

  const run = async (e: FormEvent) => {
    e.preventDefault()
    setError(null)
    try {
      const call = osqueryCall(hardeningSql())
      await job.start(tgt, tgtType, 'cmd.run', call.arg, call.kwarg)
    } catch (err) {
      setError(err as Error)
    }
  }

  const r = job.run
  const s = r ? summarize(r.results) : null
  const waiting = r && !r.done ? r.minions.length - Object.keys(r.results).length : 0

  return (
    <>
      <Link to="/compliance" className="mb-4 inline-flex items-center gap-1 text-sm text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200">
        <ArrowLeft className="size-4" /> Compliance
      </Link>
      <PageHeader
        title="Hardening checks"
        description={`${CHECKS.length} common Linux hardening checks, of the kind CIS benchmarks recommend (SSH, accounts, file permissions, network and kernel settings, services), read with osquery. Nothing on the minions changes.`}
      />

      <Card className="mb-6">
        <form onSubmit={run} className="flex flex-wrap items-end gap-3 p-4">
          <div className="min-w-64 flex-1">
            <TargetField
              tgt={tgt}
              tgtType={tgtType}
              onChange={(t, tt) => {
                setTgt(t)
                setTgtType(tt)
              }}
            />
          </div>
          <Button type="submit" variant="primary" icon={<Play className="size-4" />} disabled={!canRun || !tgt.trim()} loading={!!r && !r.done}>
            Run the checks
          </Button>
        </form>
        {!canRun && (
          <div className="px-4 pb-4">
            <PermNote>Running the checks needs permission for cmd.run (osquery runs through it).</PermNote>
          </div>
        )}
      </Card>
      {error && (
        <div className="mb-4">
          <ErrorBox error={error} />
        </div>
      )}

      {!r && (
        <Card>
          <Empty icon={<ShieldCheck />} title="Check how hardened your minions are">
            Each minion answers all the checks in one osquery query; the minions need{' '}
            <Link to="/query" className="text-accent-700 underline underline-offset-2 dark:text-accent-400">
              osquery
            </Link>
            .
          </Empty>
        </Card>
      )}

      {r && s && (
        <div className="space-y-6">
          <div className="grid gap-4 sm:grid-cols-3">
            <Stat label="Average score" value={s.score === null ? '–' : `${s.score}%`} icon={<Gauge className="size-4" />} tone={s.score === null ? 'zinc' : scoreTone(s.score)} hint={`over ${s.minions.length} ${s.minions.length === 1 ? 'minion' : 'minions'}`} />
            <Stat
              label="Checks failing somewhere"
              value={s.checks.filter((c) => c.fail.length).length}
              icon={<ShieldX className="size-4" />}
              tone={s.checks.some((c) => c.fail.length) ? 'amber' : 'green'}
              hint={`of ${CHECKS.length}`}
            />
            <Stat label="Without osquery" value={s.missing.length} icon={<Unplug className="size-4" />} tone={s.missing.length ? 'amber' : 'zinc'} hint={waiting ? `${waiting} still answering` : s.errors.length ? `${s.errors.length} with errors` : undefined} />
          </div>

          {!r.done && s.minions.length === 0 && <Spinner />}

          <Card>
            <CardHeader
              title="Checks"
              subtitle="The ones that fail somewhere first."
              actions={
                <Button
                  size="sm"
                  icon={<Download className="size-3.5" />}
                  disabled={!r.done || !s.minions.length}
                  onClick={() => download(`hardening-${new Date(r.started ?? Date.now()).toISOString().slice(0, 10)}.csv`, 'text/csv', evidenceCsv(s, { jid: r.jid, at: new Date(r.started ?? 0).toISOString() }))}
                >
                  Evidence (CSV)
                </Button>
              }
            />
            <ul className="divide-y divide-zinc-100 dark:divide-zinc-800/70">
              {[...s.checks]
                .sort((a, b) => b.fail.length - a.fail.length)
                .map((c) => (
                  <li key={c.id} className="flex flex-wrap items-start gap-x-4 gap-y-1 px-4 py-3 text-sm">
                    <div className="min-w-64 flex-1">
                      <p className="flex flex-wrap items-center gap-2 font-medium">
                        {c.title} <Badge>{c.area}</Badge>
                      </p>
                      <p className="mt-0.5 text-xs text-zinc-600 dark:text-zinc-400">{c.why}</p>
                      {c.fail.length > 0 && <p className="mt-1 font-mono text-xs text-red-700 dark:text-red-400">{c.fail.join(', ')}</p>}
                    </div>
                    <Badge tone={c.fail.length ? 'red' : c.pass.length ? 'green' : 'zinc'}>
                      {c.fail.length ? `fails on ${c.fail.length}` : c.pass.length ? 'passes everywhere' : 'no answer'}
                    </Badge>
                  </li>
                ))}
            </ul>
          </Card>

          {s.minions.length > 0 && (
            <Card>
              <CardHeader title="Minions" subtitle="Lowest score first." />
              <ul className="divide-y divide-zinc-100 dark:divide-zinc-800/70">
                {s.minions.map((m) => (
                  <li key={m.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2.5 text-sm">
                    <Link to={`/minions/${encodeURIComponent(m.id)}`} className="font-mono font-medium hover:underline">
                      {m.id}
                    </Link>
                    <Badge tone={scoreTone(m.score)}>{m.score}%</Badge>
                    <span className={clsx('text-xs', m.failed.length ? 'text-zinc-600 dark:text-zinc-400' : 'text-zinc-500')}>
                      {m.failed.length ? `fails ${m.failed.map((id) => CHECKS.find((c) => c.id === id)?.title ?? id).join('; ')}` : 'passes every check'}
                    </span>
                  </li>
                ))}
              </ul>
            </Card>
          )}

          {(s.missing.length > 0 || s.errors.length > 0) && (
            <Card>
              <CardHeader title="Not checked" />
              <ul className="divide-y divide-zinc-100 text-sm dark:divide-zinc-800/70">
                {s.missing.map((id) => (
                  <li key={id} className="px-4 py-2.5">
                    <span className="font-mono font-medium">{id}</span> <span className="text-xs text-zinc-500 dark:text-zinc-400">has no osquery; install it from the Query page</span>
                  </li>
                ))}
                {s.errors.map((e) => (
                  <li key={e.minion} className="px-4 py-2.5">
                    <span className="font-mono font-medium">{e.minion}</span> <span className="font-mono text-xs text-red-700 dark:text-red-400">{e.error}</span>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>
      )}
    </>
  )
}
