import { ArrowLeft, ArrowLeftRight, GitCompare } from 'lucide-react'
import { useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { Badge, Button, Card, CardHeader, Empty, ErrorBox, Field, PageHeader, Select, Spinner } from '../components/ui'
import { diffFlat, diffPackages, flatten, type Row } from '../lib/compare'
import { useAsync } from '../lib/hooks'
import { useSalt, useSession } from '../lib/session'
import { useVulnApi } from '../lib/vulnapi'

/** Two minions side by side: the grains and installed packages that differ. */
export function ComparePage() {
  const salt = useSalt()
  const { session } = useSession()
  const vulns = useVulnApi()
  const [params, setParams] = useSearchParams()
  const a = params.get('a') ?? ''
  const b = params.get('b') ?? ''
  const set = (k: 'a' | 'b', v: string) =>
    setParams(
      (p) => {
        const next = new URLSearchParams(p)
        next.set(k, v)
        return next
      },
      { replace: true },
    )
  const keys = useAsync(() => salt.keys(), [salt])
  // full grains from the master's cache: nothing runs on the minions, and a minion that's down compares too
  const grains = useAsync(() => (a && b ? salt.runner<Record<string, unknown>>('cache.grains', { tgt: `${a},${b}`, tgt_type: 'list' }) : Promise.resolve(null)), [salt, a, b])
  // installed packages from the latest vulnerability scan, where there is one
  const pkgs = useAsync(
    () =>
      a && b && session?.mode !== 'live'
        ? Promise.all([a, b].map((m) => vulns.minionPackages(m).then((r) => r.packages, () => null)))
        : Promise.resolve(null),
    [vulns, a, b, session?.mode],
  )
  const [showIdentity, setShowIdentity] = useState(false)

  const ga = grains.data?.[a]
  const gb = grains.data?.[b]
  const g = ga && gb ? diffFlat(flatten(ga), flatten(gb)) : null
  const p = pkgs.data?.[0] && pkgs.data[1] ? diffPackages(pkgs.data[0], pkgs.data[1]) : null
  const minions = keys.data?.minions ?? []

  return (
    <>
      <Link to="/minions" className="mb-4 inline-flex items-center gap-1 text-sm text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200">
        <ArrowLeft className="size-4" /> Minions
      </Link>
      <PageHeader title="Compare minions" description="What sets two minions apart: their grains, from the master's cache, and the packages their latest vulnerability scan found. Nothing runs on them." />

      <Card className="mb-6">
        <div className="flex flex-wrap items-end gap-3 p-4">
          <Field label="Minion">
            <Select value={a} onChange={(e) => set('a', e.target.value)} className="w-56 font-mono" aria-label="First minion">
              <option value="">Pick one…</option>
              {minions.map((m) => (
                <option key={m}>{m}</option>
              ))}
            </Select>
          </Field>
          <Button
            icon={<ArrowLeftRight className="size-4" />}
            aria-label="Swap"
            title="Swap"
            disabled={!a || !b}
            onClick={() => setParams({ a: b, b: a }, { replace: true })}
          />
          <Field label="With">
            <Select value={b} onChange={(e) => set('b', e.target.value)} className="w-56 font-mono" aria-label="Second minion">
              <option value="">Pick one…</option>
              {minions.map((m) => (
                <option key={m}>{m}</option>
              ))}
            </Select>
          </Field>
        </div>
      </Card>

      {(!a || !b) && (
        <Card>
          <Empty icon={<GitCompare />} title="Pick two minions">
            Or select two on the Minions list and choose Compare.
          </Empty>
        </Card>
      )}
      {grains.error && <ErrorBox error={grains.error} />}

      {a && b && (
        <div className="space-y-6">
          <Card>
            <CardHeader
              title={g ? `Grains that differ (${g.differ.length})` : 'Grains'}
              subtitle={g ? `${g.same} the same${g.identity.length ? `, ${g.identity.length} that always differ between machines` : ''}` : undefined}
              actions={
                g && g.identity.length > 0 ? (
                  <label className="flex items-center gap-2 text-xs text-zinc-600 dark:text-zinc-400">
                    <input type="checkbox" checked={showIdentity} onChange={(e) => setShowIdentity(e.target.checked)} className="accent-accent-600" />
                    Show names, addresses and ids
                  </label>
                ) : undefined
              }
            />
            {grains.loading ? (
              <Spinner />
            ) : !ga || !gb ? (
              <p className="p-4 text-sm text-zinc-500 dark:text-zinc-400">The master has no cached grains for {!ga ? a : b}.</p>
            ) : (
              <DiffTable a={a} b={b} rows={showIdentity ? [...g!.differ, ...g!.identity].sort((x, y) => x.key.localeCompare(y.key)) : g!.differ} empty="Their grains are the same." />
            )}
          </Card>

          {session?.mode !== 'live' && (
            <Card>
              <CardHeader title={p ? `Packages that differ (${p.differ.length})` : 'Packages'} subtitle={p ? `${p.same} the same version on both` : undefined} />
              {pkgs.loading ? (
                <Spinner />
              ) : !p ? (
                <p className="p-4 text-sm text-zinc-500 dark:text-zinc-400">
                  {pkgs.data?.[0] ? b : a} has no package inventory yet; a{' '}
                  <Link to="/vulnerabilities" className="text-accent-700 underline underline-offset-2 hover:text-accent-800 dark:text-accent-400 dark:hover:text-accent-100">
                    vulnerability scan
                  </Link>{' '}
                  makes one.
                </p>
              ) : (
                <DiffTable a={a} b={b} rows={p.differ.map((r) => ({ key: r.name, a: r.a, b: r.b }))} empty="The same packages, in the same versions." label="Package" />
              )}
            </Card>
          )}
        </div>
      )}
    </>
  )
}

function DiffTable({ a, b, rows, empty, label = 'Grain' }: { a: string; b: string; rows: Row[]; empty: string; label?: string }) {
  if (!rows.length) return <p className="p-4 text-sm text-zinc-500 dark:text-zinc-400">{empty}</p>
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-zinc-200 text-left text-xs text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
            <th className="py-2 pr-3 pl-4 font-medium">{label}</th>
            <th className="px-3 py-2 font-mono font-medium">{a}</th>
            <th className="px-3 py-2 pr-4 font-mono font-medium">{b}</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800/70">
          {rows.map((r) => (
            <tr key={r.key} className="align-top">
              <td className="py-2 pr-3 pl-4 font-mono text-xs font-medium">{r.key}</td>
              <td className="max-w-xs px-3 py-2 font-mono text-xs break-all">{r.a ?? <Badge>missing</Badge>}</td>
              <td className="max-w-xs px-3 py-2 pr-4 font-mono text-xs break-all">{r.b ?? <Badge>missing</Badge>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
