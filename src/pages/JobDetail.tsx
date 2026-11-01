import { ArrowLeft, RotateCcw } from 'lucide-react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { formatArgs } from '../api/salt'
import { ResultView } from '../components/ResultView'
import { Badge, Button, Card, CardHeader, ErrorBox, Spinner } from '../components/ui'
import { useAsync } from '../lib/hooks'
import { useSalt } from '../lib/session'
import { funTone } from './Jobs'

export function JobDetailPage() {
  const { jid = '' } = useParams()
  const salt = useSalt()
  const navigate = useNavigate()
  const { data, error, loading, reload } = useAsync(() => salt.job(jid), [salt, jid])

  const results = Object.fromEntries(Object.entries(data?.Result ?? {}).map(([id, r]) => [id, r.return]))
  const missing = (data?.Minions ?? []).filter((m) => !(m in results))
  const target = Array.isArray(data?.Target) ? data.Target.join(',') : data?.Target

  const rerun = () => {
    if (!data) return
    const args = formatArgs(data.Arguments)
    navigate(`/run?tgt=${encodeURIComponent(target ?? '*')}&tgt_type=${data['Target-type']}&fun=${encodeURIComponent(data.Function)}&args=${encodeURIComponent(args)}`)
  }

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
            {!/^(wheel|runner)\./.test(data.Function) && (
              <Button icon={<RotateCcw className="size-4" />} onClick={rerun}>
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
            <CardHeader title="Results" actions={<Button size="sm" variant="ghost" onClick={reload} loading={loading}>Refresh</Button>} />
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
