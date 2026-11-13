import { ArrowLeft, GitCompare, Loader2, RotateCcw, Square } from 'lucide-react'
import { useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { formatArgs } from '../api/salt'
import { ResultActions, ResultView } from '../components/ResultView'
import { StopJobModal } from '../components/StopJob'
import { Badge, Button, Card, CardHeader, ErrorBox, Spinner } from '../components/ui'
import { useAsync } from '../lib/hooks'
import { jobResults, loadJobDetail } from '../lib/job-detail'
import { useCan, useSalt, useSession } from '../lib/session'
import { funTone } from '../lib/format'
import { CompareWithModal } from './JobCompare'

export function JobDetailPage() {
  const { jid = '' } = useParams()
  const salt = useSalt()
  const can = useCan()
  const navigate = useNavigate()
  const { session } = useSession()
  const fromServer = session?.mode === 'server'
  // with the server, prefer its history (kept for weeks); the master's cache only keeps ~24h
  const { data, error, loading, reload } = useAsync(() => loadJobDetail(salt, fromServer, jid), [salt, jid, fromServer])

  const results = jobResults(data)
  const missing = (data?.Minions ?? []).filter((m) => !(m in results))
  const target = Array.isArray(data?.Target) ? data.Target.join(',') : data?.Target
  // of the minions that haven't returned, which are still working on it
  const missingKey = missing.join(',')
  const running = useAsync(() => (missingKey ? salt.stillRunning(jid, missingKey.split(',')) : Promise.resolve([])), [salt, jid, missingKey])
  const stillRunning = running.data ?? []
  const noReturn = missing.filter((m) => !stillRunning.includes(m))
  const [stopping, setStopping] = useState(false)
  const [comparing, setComparing] = useState(false)
  const refresh = () => {
    void reload()
    void running.reload()
  }

  const rerun = (minions?: string[]) => {
    if (!data) return
    const args = formatArgs(data.Arguments)
    const tgt = minions ? minions.join(',') : (target ?? '*')
    const tgtType = minions ? 'list' : data['Target-type']
    navigate(`/run?tgt=${encodeURIComponent(tgt)}&tgt_type=${tgtType}&fun=${encodeURIComponent(data.Function)}&args=${encodeURIComponent(args)}`)
  }
  const canRerun = !!data && !/^(wheel|runner)\./.test(data.Function) && can('local', data.Function)

  return (
    <>
      <Link to="/jobs" className="mb-4 inline-flex items-center gap-1 text-sm text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200">
        <ArrowLeft className="size-4" /> Jobs
      </Link>
      {error && <ErrorBox error={error} onRetry={reload} />}
      {loading && !data && <Spinner />}
      {data && (
        <>
          <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone={funTone(data.Function)} className="font-mono text-sm">
                  {data.Function}
                </Badge>
                <span className="font-mono text-sm text-zinc-600 dark:text-zinc-400">{formatArgs(data.Arguments)}</span>
              </div>
              <p className="mt-2 font-mono text-xs text-zinc-500">jid {jid}</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button icon={<GitCompare className="size-4" />} onClick={() => setComparing(true)}>
                Compare with…
              </Button>
              {canRerun && (
                <Button icon={<RotateCcw className="size-4" />} onClick={() => rerun()}>
                  Run again
                </Button>
              )}
            </div>
          </div>

          <dl className="mb-6 grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-zinc-200 bg-zinc-200 text-sm sm:grid-cols-4 dark:border-zinc-800 dark:bg-zinc-800">
            {[
              ['Target', <span key="t" className="font-mono">{data['Target-type'] !== 'glob' && `${data['Target-type']}:`}{target}</span>],
              ['User', data.User],
              ['Started', salt.jidDate(jid)?.toLocaleString() ?? data.StartTime],
              ['Returned', `${Object.keys(results).length} / ${data.Minions?.length ?? '?'}`],
            ].map(([k, v], i) => (
              <div key={i} className="bg-white p-3 dark:bg-zinc-900">
                <dt className="text-xs text-zinc-500">{k}</dt>
                <dd className="mt-0.5 truncate font-medium">{v}</dd>
              </div>
            ))}
          </dl>

          <Card>
            <CardHeader
              title="Results"
              actions={
                <div className="flex flex-wrap items-center gap-1">
                  <ResultActions
                    job={{ jid, fun: data.Function, target, targetType: data['Target-type'] }}
                    results={results}
                    expected={data.Minions ?? []}
                    onRetry={canRerun ? (m) => rerun(m) : undefined}
                  />
                  <Button size="sm" variant="ghost" onClick={refresh} loading={loading}>
                    Refresh
                  </Button>
                </div>
              }
            />
            <div className="p-3">
              {Object.keys(results).length === 0 && missing.length === 0 ? (
                <p className="p-4 text-sm text-zinc-500">No returns stored for this job.</p>
              ) : (
                <ResultView results={results} onRunOn={canRerun ? (m) => rerun(m) : undefined} />
              )}
              {stillRunning.length > 0 && (
                <div className="mt-3 flex flex-wrap items-center gap-3 px-1 text-sm">
                  <span className="flex items-center gap-1.5 text-zinc-600 dark:text-zinc-400">
                    <Loader2 className="size-3.5 animate-spin" /> Still running on <span className="font-mono">{stillRunning.join(', ')}</span>
                  </span>
                  {can('local', 'saltutil.kill_job') && (
                    <Button size="sm" variant="danger" icon={<Square className="size-3" />} onClick={() => setStopping(true)}>
                      Stop
                    </Button>
                  )}
                </div>
              )}
              {noReturn.length > 0 && (
                <p className="mt-3 px-1 text-sm text-zinc-500">
                  No return from: <span className="font-mono">{noReturn.join(', ')}</span>
                </p>
              )}
            </div>
          </Card>
          {comparing && <CompareWithModal job={{ ...data, jid }} onClose={() => setComparing(false)} />}
          <StopJobModal
            job={stopping ? { jid, fun: data.Function, args: data.Arguments, minions: stillRunning } : null}
            onClose={() => setStopping(false)}
            onStopped={refresh}
          />
        </>
      )}
    </>
  )
}
