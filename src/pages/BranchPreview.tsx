import clsx from 'clsx'
import { ArrowLeft, GitBranch, GitCompare, Search } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import type { TargetType } from '../api/types'
import { JsonView } from '../components/JsonView'
import { TargetField } from '../components/TargetField'
import { Badge, Button, Card, CardHeader, Empty, ErrorBox, Field, Input, PageHeader, PermNote, Select, Spinner, type Tone } from '../components/ui'
import { DELTA_LABEL, envDiff, type DeltaKind, type EnvDiff } from '../lib/envdiff'
import { useAsync } from '../lib/hooks'
import { useCan, useSalt } from '../lib/session'
import { useJob } from '../lib/useJob'

const TONE: Record<DeltaKind, Tone> = { fails: 'red', changes: 'amber', new: 'amber', dropped: 'blue', settles: 'green' }

/**
 * What a branch would change: the highstate dry-run from a gitfs branch (its saltenv) next to the
 * one from base, on the same minions, keeping only the states whose outcome differs.
 */
export function BranchPreviewPage() {
  const salt = useSalt()
  const can = useCan()
  const canRun = can('local', 'state.apply')
  const envs = useAsync(() => salt.runner<string[]>('fileserver.envs').then((e) => (Array.isArray(e) ? e.filter((x) => x !== 'base') : [])), [salt])
  const [tgt, setTgt] = useState('*')
  const [tgtType, setTgtType] = useState<TargetType>('glob')
  const [env, setEnv] = useState('')
  const [error, setError] = useState<Error | null>(null)
  const [compared, setCompared] = useState<string | null>(null)
  const base = useJob()
  const branch = useJob()
  const branchName = env || envs.data?.[0] || ''

  const preview = async (e: FormEvent) => {
    e.preventDefault()
    setError(null)
    try {
      // both dry runs at once, on the same target
      await Promise.all([base.start(tgt, tgtType, 'state.apply', [], { test: true, saltenv: 'base' }), branch.start(tgt, tgtType, 'state.apply', [], { test: true, saltenv: branchName })])
      setCompared(branchName)
    } catch (err) {
      setError(err as Error)
    }
  }

  const running = (!!base.run && !base.run.done) || (!!branch.run && !branch.run.done)
  const minions = [...new Set([...Object.keys(base.run?.results ?? {}), ...Object.keys(branch.run?.results ?? {})])].sort()
  // a minion is compared once both runs are in for it
  const rows = minions
    .filter((m) => base.run && branch.run && m in base.run.results && m in branch.run.results)
    .map((m) => ({ minion: m, diff: envDiff(base.run!.results[m], branch.run!.results[m]) }))
  const affected = rows.filter((r) => 'error' in r.diff || r.diff.deltas.length > 0)
  const same = rows.filter((r) => 'deltas' in r.diff && r.diff.deltas.length === 0).map((r) => r.minion)
  const failing = rows.filter((r) => 'error' in r.diff || r.diff.deltas.some((d) => d.kind === 'fails')).length

  return (
    <>
      <Link to="/compliance" className="mb-4 inline-flex items-center gap-1 text-sm text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200">
        <ArrowLeft className="size-4" /> Compliance
      </Link>
      <PageHeader title="Preview a branch" description="See what a branch of your states (a gitfs saltenv) would change before you merge it: the highstate is dry-run from the branch and from base, on the same minions, and only the differences are shown." />

      <Card className="mb-6">
        <form onSubmit={preview} className="space-y-4 p-4">
          <TargetField
            tgt={tgt}
            tgtType={tgtType}
            onChange={(t, tt) => {
              setTgt(t)
              setTgtType(tt)
            }}
          />
          <div className="flex flex-wrap items-end gap-3">
            <Field label="Branch (saltenv)">
              {envs.data && envs.data.length > 0 ? (
                <Select value={branchName} onChange={(e) => setEnv(e.target.value)} className="w-64 font-mono" aria-label="Branch">
                  {envs.data.map((e) => (
                    <option key={e}>{e}</option>
                  ))}
                </Select>
              ) : (
                <Input value={env} onChange={(e) => setEnv(e.target.value)} placeholder="feature-branch" className="w-64 font-mono" aria-label="Branch" required />
              )}
            </Field>
            <Button type="submit" variant="primary" icon={<GitCompare className="size-4" />} loading={running} disabled={!canRun || !branchName}>
              {running ? 'Comparing…' : 'Preview'}
            </Button>
          </div>
          {!canRun && <PermNote>Your account cannot run state.apply.</PermNote>}
          {envs.data?.length === 0 && <p className="text-xs text-zinc-500 dark:text-zinc-400">The master lists no environment besides base. With gitfs, every branch is one; type its name to compare anyway.</p>}
          <p className="text-xs text-zinc-500 dark:text-zinc-400">Both runs are dry runs (test=True): nothing changes on the minions.</p>
        </form>
      </Card>

      {error && (
        <div className="mb-6">
          <ErrorBox error={error} />
        </div>
      )}

      {!base.run && (
        <Card>
          <Empty icon={<GitBranch />} title="Pick a branch and a target">
            The minions run both dry runs side by side; it takes as long as a compliance check.
          </Empty>
        </Card>
      )}

      {base.run && branch.run && (
        <Card>
          <CardHeader
            title={
              <span className="flex flex-wrap items-center gap-2">
                <span className="font-mono">{compared}</span> compared with <span className="font-mono">base</span>
              </span>
            }
            subtitle={
              running
                ? `${rows.length} of ${base.run.minions.length} minions compared…`
                : `${affected.length} of ${rows.length} ${rows.length === 1 ? 'minion' : 'minions'} would differ${failing ? `, ${failing} with failures` : ''}`
            }
          />
          {running && rows.length === 0 && <Spinner label="Dry-running both…" />}
          <ul className="divide-y divide-zinc-100 dark:divide-zinc-800/70">
            {affected.map((r) => (
              <MinionDiff key={r.minion} minion={r.minion} diff={r.diff} />
            ))}
          </ul>
          {!running && affected.length === 0 && rows.length > 0 && <Empty icon={<Search />} title="No differences">The branch would do exactly what base does on these minions.</Empty>}
          {same.length > 0 && affected.length > 0 && (
            <p className="border-t border-zinc-100 px-4 py-2 text-xs text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
              Same as base on <span className="font-mono">{same.join(', ')}</span>.
            </p>
          )}
        </Card>
      )}
    </>
  )
}

function MinionDiff({ minion, diff }: { minion: string; diff: EnvDiff }) {
  return (
    <li className="px-4 py-3">
      <p className="mb-2 font-mono text-sm font-medium">
        <Link to={`/minions/${encodeURIComponent(minion)}`} className="hover:text-accent-700 dark:hover:text-accent-400">
          {minion}
        </Link>
      </p>
      {'error' in diff ? (
        <p className="rounded-lg bg-red-50 p-2 font-mono text-xs whitespace-pre-wrap text-red-800 dark:bg-red-950/40 dark:text-red-300">{diff.error}</p>
      ) : (
        <ul className="space-y-2">
          {diff.deltas.map((d) => (
            <li key={d.key} className="text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone={TONE[d.kind]}>{DELTA_LABEL[d.kind]}</Badge>
                <span className="font-mono">{d.id}</span>
                {d.sls && <span className="text-xs text-zinc-500 dark:text-zinc-400">{d.sls}</span>}
              </div>
              {d.comment && <p className={clsx('mt-0.5 text-xs', d.kind === 'fails' ? 'text-red-700 dark:text-red-400' : 'text-zinc-600 dark:text-zinc-400')}>{d.comment}</p>}
              {d.changes && (
                <div className="mt-1">
                  <JsonView value={d.changes} openDepth={1} />
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </li>
  )
}
