import clsx from 'clsx'
import { ArrowRight, ChevronRight, ExternalLink, Package, PackageCheck, Play, RefreshCw, Search, Server, Unplug } from 'lucide-react'
import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import type { TargetType } from '../api/types'
import { ResultView } from '../components/ResultView'
import { TargetField } from '../components/TargetField'
import { Badge, Button, Card, CardHeader, Empty, ErrorBox, Input, Modal, PageHeader, PermNote, Spinner, Stat, Tabs } from '../components/ui'
import { useStoredState } from '../lib/hooks'
import { useCan, useSalt, useSession } from '../lib/session'
import { useJob } from '../lib/useJob'
import { relTime } from './Jobs'

type Upgrades = Record<string, string> // package -> available version

interface Plan {
  title: string
  fun: 'pkg.install' | 'pkg.upgrade'
  minions: string[]
  pkgs?: string[]
}

const isUpgrades = (v: unknown): v is Upgrades => !!v && typeof v === 'object' && !Array.isArray(v) && Object.values(v).every((x) => typeof x === 'string')

export function PatchesPage() {
  const { session } = useSession()
  const can = useCan()
  const canScan = can('local', 'pkg.list_upgrades')
  const canInstall = can('local', 'pkg.install')
  const canUpgradeAll = can('local', 'pkg.upgrade')
  const scan = useJob()
  const upgrade = useJob()
  const scope = `salt-shaker.patches.${session?.mode}.${session?.apiUrl}`
  const [last, setLast] = useStoredState<{ jid: string; tgt: string; tgtType: TargetType } | null>(scope, null)
  const [tgt, setTgt] = useState(last?.tgt ?? '*')
  const [tgtType, setTgtType] = useState<TargetType>(last?.tgtType ?? 'glob')
  const [refresh, setRefresh] = useStoredState('salt-shaker.patches.refresh', true)
  const [view, setView] = useState<'package' | 'minion'>('package')
  const [query, setQuery] = useState('')
  const [error, setError] = useState<Error | null>(null)
  const [plan, setPlan] = useState<Plan | null>(null)

  useEffect(() => {
    if (last && !scan.run) scan.load(last.jid).catch(() => setLast(null))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const startScan = async (e?: FormEvent) => {
    e?.preventDefault()
    setError(null)
    try {
      const jid = await scan.start(tgt, tgtType, 'pkg.list_upgrades', [], refresh ? { refresh: true } : {})
      setLast({ jid, tgt, tgtType })
    } catch (err) {
      setError(err as Error)
    }
  }

  const runPlan = async () => {
    if (!plan) return
    setError(null)
    try {
      const kwarg = plan.fun === 'pkg.install' ? { pkgs: plan.pkgs, only_upgrade: true } : {}
      await upgrade.start(plan.minions.join(','), 'list', plan.fun, [], kwarg)
    } catch (err) {
      setError(err as Error)
    }
    setPlan(null)
  }

  const run = scan.run
  const { byMinion, byPackage, failed } = useMemo(() => {
    const byMinion: Record<string, Upgrades> = {}
    const failed: string[] = []
    for (const [id, ret] of Object.entries(run?.results ?? {})) {
      if (isUpgrades(ret)) byMinion[id] = ret
      else failed.push(id)
    }
    const byPackage: Record<string, { versions: Set<string>; minions: string[] }> = {}
    for (const [id, ups] of Object.entries(byMinion)) {
      for (const [pkg, ver] of Object.entries(ups)) {
        byPackage[pkg] ??= { versions: new Set(), minions: [] }
        byPackage[pkg].versions.add(ver)
        byPackage[pkg].minions.push(id)
      }
    }
    return { byMinion, byPackage, failed }
  }, [run])

  const q = query.toLowerCase()
  const packages = Object.entries(byPackage)
    .filter(([pkg, p]) => !q || pkg.toLowerCase().includes(q) || p.minions.some((m) => m.includes(q)))
    .sort((a, b) => b[1].minions.length - a[1].minions.length || a[0].localeCompare(b[0]))
  const minions = Object.entries(byMinion)
    .filter(([id, ups]) => !q || id.includes(q) || Object.keys(ups).some((p) => p.toLowerCase().includes(q)))
    .sort((a, b) => Object.keys(b[1]).length - Object.keys(a[1]).length || a[0].localeCompare(b[0]))
  const needing = Object.values(byMinion).filter((u) => Object.keys(u).length > 0).length
  const noReturn = run?.done ? run.minions.filter((m) => !(m in run.results)) : []
  const scanning = !!run && !run.done

  return (
    <>
      <PageHeader title="Patches" description="See pending package upgrades across your fleet and roll them out." />

      <Card className="mb-6">
        <form onSubmit={startScan} className="flex flex-wrap items-start gap-3 p-4">
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
          <div className="flex flex-col gap-2 sm:mt-[22px]">
            <Button type="submit" variant="primary" icon={<Search className="size-4" />} loading={scanning} disabled={!canScan}>
              {scanning ? `Scanning… ${Object.keys(run.results).length}/${run.minions.length}` : 'Scan for updates'}
            </Button>
            <label className="flex items-center gap-2 text-xs text-zinc-500">
              <input type="checkbox" checked={refresh} onChange={(e) => setRefresh(e.target.checked)} className="accent-accent-600" />
              Refresh package index first
            </label>
          </div>
        </form>
        {(!canScan || !canInstall || !canUpgradeAll) && (
          <PermNote className="px-4 pb-3">
            {!canScan ? 'Your account cannot scan for upgrades.' : 'Your account can scan but not upgrade' + (canInstall ? ' everything at once.' : canUpgradeAll ? ' single packages.' : ' packages.')}
          </PermNote>
        )}
        {run && (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-zinc-100 px-4 py-2 text-xs text-zinc-500 dark:border-zinc-800">
            <span>
              {run.done ? 'Scanned' : 'Started'} {relTime(new Date(run.started))}
            </span>
            <Link to={`/jobs/${run.jid}`} className="inline-flex items-center gap-1 font-mono hover:text-accent-600">
              jid {run.jid} <ExternalLink className="size-3" />
            </Link>
          </div>
        )}
      </Card>

      {error && (
        <div className="mb-6">
          <ErrorBox error={error} />
        </div>
      )}

      {upgrade.run && (
        <Card className="mb-6">
          <CardHeader
            title={
              <span className="flex items-center gap-2">
                Upgrade <Badge className="font-mono">{upgrade.run.fun}</Badge>
                <Badge tone={upgrade.run.done ? 'green' : 'blue'}>
                  {Object.keys(upgrade.run.results).length}/{upgrade.run.minions.length} returned
                </Badge>
              </span>
            }
            actions={
              upgrade.run.done && (
                <Button size="sm" icon={<RefreshCw className="size-3.5" />} onClick={() => startScan()}>
                  Rescan
                </Button>
              )
            }
          />
          <div className="p-3">
            <ResultView results={upgrade.run.results} expected={upgrade.run.done ? Object.keys(upgrade.run.results) : upgrade.run.minions} />
          </div>
        </Card>
      )}

      {!run && (
        <Card>
          <Empty icon={<Package />} title="No scan yet">
            Scan a target to list the package upgrades each minion has available. Scanning changes nothing.
          </Empty>
        </Card>
      )}

      {run && (
        <>
          <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label="Need updates" value={needing} icon={<Server />} tone={needing ? 'amber' : 'zinc'} />
            <Stat label="Up to date" value={Object.keys(byMinion).length - needing} icon={<PackageCheck />} tone="green" />
            <Stat label="Packages to upgrade" value={Object.keys(byPackage).length} icon={<Package />} tone="accent" />
            <Stat label={run.done ? 'No return / errors' : 'Waiting'} value={run.done ? noReturn.length + failed.length : run.minions.length - Object.keys(run.results).length} icon={<Unplug />} tone="zinc" />
          </div>

          <Card>
            <div className="flex flex-wrap items-center gap-3 border-b border-zinc-200 p-3 dark:border-zinc-800">
              <Tabs
                value={view}
                onChange={setView}
                items={[
                  { value: 'package', label: 'By package' },
                  { value: 'minion', label: 'By minion' },
                ]}
              />
              <div className="relative min-w-48 flex-1">
                <Search className="pointer-events-none absolute top-2.5 left-3 size-4 text-zinc-400" />
                <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Filter packages or minions…" className="pl-9" />
              </div>
              {needing > 0 && run.done && canUpgradeAll && (
                <Button
                  variant="primary"
                  icon={<Play className="size-4" />}
                  onClick={() => setPlan({ title: `Upgrade everything on ${needing} minions`, fun: 'pkg.upgrade', minions: Object.entries(byMinion).filter(([, u]) => Object.keys(u).length).map(([id]) => id) })}
                >
                  Upgrade all
                </Button>
              )}
            </div>

            {scanning && Object.keys(run.results).length === 0 && <Spinner label="Asking minions for upgrades…" />}
            {run.done && Object.keys(byPackage).length === 0 && failed.length === 0 && (
              <Empty icon={<PackageCheck />} title="Everything is up to date" />
            )}

            {view === 'package' && packages.length > 0 && (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-zinc-200 text-left text-xs text-zinc-500 dark:border-zinc-800">
                      <th className="py-2.5 pr-3 pl-4 font-medium">Package</th>
                      <th className="px-3 py-2.5 font-medium">Available</th>
                      <th className="px-3 py-2.5 font-medium">Minions</th>
                      <th className="px-3 py-2.5 pr-4" />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800/70">
                    {packages.map(([pkg, p]) => (
                      <tr key={pkg}>
                        <td className="py-2.5 pr-3 pl-4 font-mono font-medium">{pkg}</td>
                        <td className="px-3 py-2.5 font-mono text-xs text-zinc-600 dark:text-zinc-400">{[...p.versions].join(', ')}</td>
                        <td className="px-3 py-2.5">
                          <div className="flex flex-wrap items-center gap-1">
                            <Badge tone="amber">{p.minions.length}</Badge>
                            {p.minions.slice(0, 5).map((m) => (
                              <span key={m} className="rounded bg-zinc-100 px-1.5 font-mono text-[11px] dark:bg-zinc-800">
                                {m}
                              </span>
                            ))}
                            {p.minions.length > 5 && <span className="text-xs text-zinc-500">+{p.minions.length - 5}</span>}
                          </div>
                        </td>
                        <td className="px-3 py-2.5 pr-4 text-right">
                          <Button size="sm" disabled={!run.done || !canInstall} onClick={() => setPlan({ title: `Upgrade ${pkg}`, fun: 'pkg.install', minions: [...p.minions].sort(), pkgs: [pkg] })}>
                            Upgrade
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {view === 'minion' && minions.length > 0 && (
              <ul className="divide-y divide-zinc-100 dark:divide-zinc-800/70">
                {minions.map(([id, ups]) => (
                  <MinionRow key={id} id={id} ups={ups} disabled={!run.done || !canUpgradeAll} onUpgrade={() => setPlan({ title: `Upgrade everything on ${id}`, fun: 'pkg.upgrade', minions: [id] })} />
                ))}
              </ul>
            )}

            {run.done && (failed.length > 0 || noReturn.length > 0) && (
              <div className="border-t border-zinc-100 px-4 py-3 text-sm text-zinc-500 dark:border-zinc-800">
                {failed.length > 0 && (
                  <p>
                    Could not list upgrades on <span className="font-mono">{failed.join(', ')}</span> — <Link className="text-accent-600 hover:underline" to={`/jobs/${run.jid}`}>see the job</Link>.
                  </p>
                )}
                {noReturn.length > 0 && (
                  <p>
                    No return from <span className="font-mono">{noReturn.join(', ')}</span>.
                  </p>
                )}
              </div>
            )}
          </Card>
        </>
      )}

      <Modal open={!!plan} onClose={() => setPlan(null)} title={plan?.title ?? ''}>
        {plan && (
          <div className="space-y-4 text-sm">
            <p className="text-zinc-600 dark:text-zinc-400">
              {plan.fun === 'pkg.upgrade' ? (
                <>
                  Runs <code className="font-mono">pkg.upgrade</code>, which upgrades <strong>all</strong> upgradable packages on:
                </>
              ) : (
                <>
                  Runs <code className="font-mono">pkg.install pkgs={JSON.stringify(plan.pkgs)} only_upgrade=True</code> on:
                </>
              )}
            </p>
            <div className="flex flex-wrap gap-1">
              {plan.minions.map((m) => (
                <span key={m} className="rounded bg-zinc-100 px-1.5 py-0.5 font-mono text-xs dark:bg-zinc-800">
                  {m}
                </span>
              ))}
            </div>
            <p className="text-xs text-amber-600 dark:text-amber-400">Services may restart while packages upgrade.</p>
            <div className="flex justify-end gap-2">
              <Button onClick={() => setPlan(null)}>Cancel</Button>
              <Button variant="success" icon={<Play className="size-4" />} onClick={runPlan}>
                Upgrade {plan.minions.length === 1 ? plan.minions[0] : `${plan.minions.length} minions`}
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </>
  )
}

function MinionRow({ id, ups, disabled, onUpgrade }: { id: string; ups: Upgrades; disabled: boolean; onUpgrade: () => void }) {
  const salt = useSalt()
  const [open, setOpen] = useState(false)
  const [current, setCurrent] = useState<Record<string, string> | null>(null)
  const names = Object.keys(ups).sort()

  // installed versions are fetched lazily, only for rows someone opens
  const namesKey = names.join(' ')
  useEffect(() => {
    if (!open || current || !namesKey) return
    const list = namesKey.split(' ')
    salt
      .local<Record<string, string> | string>(id, 'pkg.version', list, {}, 'list')
      .then((res) => {
        const r = res[id]
        setCurrent(typeof r === 'string' ? { [list[0]]: r } : (r ?? {}))
      })
      .catch(() => setCurrent({}))
  }, [open, current, namesKey, salt, id])

  return (
    <li>
      <div className="flex items-center gap-3 px-4 py-2.5">
        <button onClick={() => names.length && setOpen(!open)} className="flex min-w-0 flex-1 items-center gap-3 text-left">
          <ChevronRight className={clsx('size-4 shrink-0 text-zinc-400 transition-transform', open && 'rotate-90', !names.length && 'invisible')} />
          <span className="font-mono text-sm font-medium">{id}</span>
          {names.length ? <Badge tone="amber">{names.length} pending</Badge> : <Badge tone="green">up to date</Badge>}
        </button>
        {names.length > 0 && (
          <Button size="sm" disabled={disabled} onClick={onUpgrade}>
            Upgrade all
          </Button>
        )}
      </div>
      {open && (
        <div className="border-t border-zinc-100 bg-zinc-50/50 px-4 py-2 pl-11 dark:border-zinc-800 dark:bg-zinc-950/30">
          <table className="text-sm">
            <tbody>
              {names.map((n) => (
                <tr key={n}>
                  <td className="py-1 pr-6 font-mono">{n}</td>
                  <td className="py-1 pr-2 font-mono text-xs text-zinc-500">{current ? current[n] || '?' : '…'}</td>
                  <td className="py-1 pr-2">
                    <ArrowRight className="size-3 text-zinc-400" />
                  </td>
                  <td className="py-1 font-mono text-xs text-emerald-600 dark:text-emerald-400">{ups[n]}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </li>
  )
}
