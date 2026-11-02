import { ArrowLeft, RotateCcw } from 'lucide-react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { formatArgs } from '../api/salt'
import { ResultActions, ResultView } from '../components/ResultView'
import { Badge, Button, Card, CardHeader, ErrorBox, Spinner } from '../components/ui'
import { useAsync } from '../lib/hooks'
import { history, parseStoredArgs } from '../api/server'
import { SaltError, type JobDetail } from '../api/types'
import { useCan, useSalt, useSession } from '../lib/session'
import { funTone } from '../lib/format'

export function JobDetailPage() {
  const { jid = '' } = useParams()
  const salt = useSalt()
  const can = useCan()
  const navigate = useNavigate()
  const { session } = useSession()
  const fromServer = session?.mode === 'server'
  // with the server, prefer its history (kept for weeks); the master's cache only keeps ~24h
  const { data, error, loading, reload } = useAsync(async (): Promise<JobDetail> => {
    if (fromServer) {
      try {
        const { job, returns } = await history.job(jid)
        return {
          jid,
          Function: job.fun,
          Arguments: parseStoredArgs(job.args),
          Target: job.target ?? '',
          'Target-type': job.targetType ?? 'glob',
          User: job.shakerUser ?? job.saltUser ?? '',
          StartTime: job.startedAt,
          Minions: JSON.parse(job.minions ?? '[]') as string[],
          Result: Object.fromEntries(returns.map((r) => [r.minion, { return: r.ret, retcode: r.retcode ?? undefined, success: r.success ?? undefined }])),
        }
      } catch (e) {
        if (!(e instanceof SaltError && e.status === 404)) throw e
      }
    }
    return salt.job(jid)
  }, [salt, jid, fromServer])

  const results = Object.fromEntries(Object.entries(data?.Result ?? {}).map(([id, r]) => [id, r.return]))
  const missing = (data?.Minions ?? []).filter((m) => !(m in results))
  const target = Array.isArray(data?.Target) ? data.Target.join(',') : data?.Target

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
            {canRerun && (
              <Button icon={<RotateCcw className="size-4" />} onClick={() => rerun()}>
                Run again
              </Button>
            )}
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
                  <Button size="sm" variant="ghost" onClick={reload} loading={loading}>
                    Refresh
                  </Button>
                </div>
              }
            />
            <div className="p-3">
              {Object.keys(results).length === 0 && missing.length === 0 ? (
                <p className="p-4 text-sm text-zinc-500">No returns stored for this job.</p>
              ) : (
                <ResultView results={results} />
              )}
              {missing.length > 0 && (
                <p className="mt-3 px-1 text-sm text-zinc-500">
                  No return from: <span className="font-mono">{missing.join(', ')}</span>
                </p>
              )}
            </div>
          </Card>
        </>
      )}
    </>
  )
}
