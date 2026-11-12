import { Activity, FileText, GitPullRequestArrow, Printer, Server, ShieldAlert, ShieldCheck, Terminal } from 'lucide-react'
import { Link } from 'react-router-dom'
import { demoOverview } from '../api/demo-overview'
import { history } from '../api/server'
import { VulnTrend } from '../components/VulnTrend'
import { Button, Card, CardHeader, ErrorBox, PageHeader, Spinner, Stat } from '../components/ui'
import { useAutomationApi } from '../lib/automation'
import { useAsync } from '../lib/hooks'
import { complianceCounts, signed, topVulnerable } from '../lib/fleet-report'
import { useSalt, useSession } from '../lib/session'
import { useVulnApi } from '../lib/vulnapi'

const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })

/**
 * The fleet over the last seven days on one page, for people who don't open the console:
 * the weekly report's numbers, compliance, the vulnerability trend and where the risk is.
 * Laid out to print, so "Save as PDF" in the print dialog makes the report to hand on.
 */
export function ReportPage() {
  const { session } = useSession()
  const mode = session?.mode
  const salt = useSalt()
  const api = useAutomationApi()
  const vulnApi = useVulnApi()
  const report = useAsync(() => api.weeklyReport(), [api])
  const status = useAsync(() => salt.status().catch(() => null), [salt])
  const compliance = useAsync(() => (mode === 'demo' ? demoOverview.compliance() : history.minionCompliance()).then((r) => r.minions).catch(() => null), [mode])
  const vulns = useAsync(() => vulnApi.minions().catch(() => null), [vulnApi])
  const trend = useAsync(() => vulnApi.trend(30).catch(() => null), [vulnApi])

  const s = report.data?.stats
  const accepted = s?.minions.accepted ?? 0
  const checks = compliance.data ? complianceCounts(compliance.data, accepted) : null
  const top = vulns.data ? topVulnerable(vulns.data.minions, 10) : []
  const down = status.data?.down ?? []

  return (
    <>
      <div className="print:hidden">
        <PageHeader
          title="Fleet report"
          description="How the fleet did over the last seven days, on one page to hand on. Print it, or pick Save as PDF in the print dialog."
          actions={
            <Button variant="primary" icon={<Printer className="size-4" />} onClick={() => window.print()} disabled={!s}>
              Print or save as PDF
            </Button>
          }
        />
      </div>
      {/* what the printed page starts with, instead of the app's header */}
      <header className="mb-6 hidden border-b border-zinc-300 pb-3 print:block">
        <p className="flex items-center gap-2 text-xl font-semibold">
          <FileText className="size-5" aria-hidden /> Salt Shaker fleet report
        </p>
        {s && (
          <p className="text-sm text-zinc-600">
            {day(s.from)} – {day(s.to)} · generated {new Date(s.to).toLocaleString()}
          </p>
        )}
      </header>

      {report.error && <ErrorBox error={report.error} onRetry={report.reload} />}
      {report.loading && !s && <Spinner />}

      {s && (
        <div className="space-y-6 print:space-y-4">
          <p className="text-sm text-zinc-600 print:hidden dark:text-zinc-400">
            {day(s.from)} – {day(s.to)}
          </p>
          <section aria-label="The week in numbers" className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-6 print:grid-cols-3 print:gap-2">
            <Stat
              label="Minions"
              value={accepted}
              icon={<Server />}
              tone={s.minions.notAnswering ? 'amber' : 'zinc'}
              hint={[s.minions.notAnswering !== null && `${s.minions.notAnswering} not answering`, s.minions.quiet && `${s.minions.quiet} quiet 30+ days`].filter(Boolean).join(', ') || undefined}
            />
            <Stat label="Failed jobs" value={s.jobs.failed} icon={<Activity />} tone={s.jobs.failed ? 'red' : 'green'} hint={`of ${s.jobs.run} run`} />
            <Stat
              label="Changes rolled out"
              value={s.changes.done}
              icon={<GitPullRequestArrow />}
              hint={[s.changes.stopped && `${s.changes.stopped} stopped or failed`, s.changes.waiting && `${s.changes.waiting} waiting for approval`].filter(Boolean).join(', ') || 'none stopped'}
            />
            <Stat
              label="Critical vulnerabilities"
              value={s.vulns?.critical ?? '–'}
              icon={<ShieldAlert />}
              tone={s.vulns?.critical ? 'red' : 'green'}
              hint={s.vulns ? `${signed(s.vulns.critical, s.vulns.criticalBefore)} · ${s.vulns.fixable} with a fix` : 'no scan yet'}
            />
            <Stat label="High vulnerabilities" value={s.vulns?.high ?? '–'} icon={<ShieldAlert />} tone={s.vulns?.high ? 'amber' : 'green'} hint={s.vulns ? signed(s.vulns.high, s.vulns.highBefore) : undefined} />
            <Stat label="Commands run" value={s.commands.count} icon={<Terminal />} hint={`by ${s.commands.people} ${s.commands.people === 1 ? 'person' : 'people'}, from the console and API`} />
          </section>

          <div className="grid gap-6 lg:grid-cols-2 print:grid-cols-2 print:gap-4">
            <Card className="break-inside-avoid">
              <CardHeader title="Compliance" subtitle="The latest highstate check (test=True) of each minion." actions={<ShieldCheck className="size-4 text-zinc-400" aria-hidden />} />
              {checks ? (
                <div className="space-y-3 p-4 text-sm">
                  <p>
                    <span className="text-2xl font-semibold tabular-nums">{checks.percent === null ? '–' : `${checks.percent}%`}</span> <span className="text-zinc-600 dark:text-zinc-400">of the checked minions are in compliance</span>
                  </p>
                  <dl className="grid grid-cols-4 gap-2 text-center">
                    {(
                      [
                        ['In compliance', checks.ok],
                        ['Drifted', checks.drift],
                        ['Errors', checks.error],
                        ['Not checked', checks.unchecked],
                      ] as const
                    ).map(([label, n]) => (
                      <div key={label} className="rounded-lg border border-zinc-200 p-2 dark:border-zinc-800">
                        <dt className="text-xs text-zinc-500 dark:text-zinc-400">{label}</dt>
                        <dd className="text-lg font-semibold tabular-nums">{n}</dd>
                      </div>
                    ))}
                  </dl>
                  {checks.attention.length > 0 && (
                    <p className="text-zinc-600 dark:text-zinc-400">
                      Needs attention: <span className="font-mono text-xs text-zinc-900 dark:text-zinc-100">{checks.attention.join(', ')}</span>
                      {checks.more > 0 && ` and ${checks.more} more`}
                    </p>
                  )}
                </div>
              ) : (
                <p className="p-4 text-sm text-zinc-500 dark:text-zinc-400">{compliance.loading ? 'Loading…' : 'No compliance checks recorded yet.'}</p>
              )}
            </Card>

            <Card className="break-inside-avoid">
              <CardHeader title="Not answering" subtitle="Minions that didn't answer when the report was made." />
              <div className="p-4 text-sm">
                {status.loading && !status.data ? (
                  <p className="text-zinc-500 dark:text-zinc-400">Asking the minions…</p>
                ) : !status.data ? (
                  <p className="text-zinc-500 dark:text-zinc-400">The master didn't say.</p>
                ) : down.length ? (
                  <p className="font-mono text-xs leading-relaxed">{down.join(', ')}</p>
                ) : (
                  <p>Every minion answered.</p>
                )}
              </div>
            </Card>
          </div>

          <Card className="break-inside-avoid">
            <CardHeader title="Vulnerabilities, last 30 days" subtitle="Daily totals from the vulnerability scans." />
            <div className="p-4">
              {(trend.data?.days.length ?? 0) >= 2 ? <VulnTrend days={trend.data!.days} /> : <p className="text-sm text-zinc-500 dark:text-zinc-400">{trend.loading ? 'Loading…' : 'The trend starts once there are two days of scans.'}</p>}
            </div>
          </Card>

          <Card className="break-inside-avoid">
            <CardHeader title="Most exposed minions" subtitle="Ranked by critical, then high vulnerabilities." />
            {top.length ? (
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-zinc-200 text-left text-xs text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
                    <th className="px-4 py-2 font-medium">Minion</th>
                    <th className="px-4 py-2 font-medium">OS</th>
                    <th className="px-4 py-2 text-right font-medium">Critical</th>
                    <th className="px-4 py-2 text-right font-medium">High</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800/70">
                  {top.map((m) => (
                    <tr key={m.minion}>
                      <td className="px-4 py-2 font-mono text-xs">
                        <Link to={`/minions/${encodeURIComponent(m.minion)}`} className="hover:underline print:no-underline">
                          {m.minion}
                        </Link>
                      </td>
                      <td className="px-4 py-2 text-zinc-600 dark:text-zinc-400">{m.os ?? '–'}</td>
                      <td className="px-4 py-2 text-right tabular-nums">{m.counts.critical}</td>
                      <td className="px-4 py-2 text-right tabular-nums">{m.counts.high}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="p-4 text-sm text-zinc-500 dark:text-zinc-400">{vulns.loading ? 'Loading…' : 'No minion has a critical or high vulnerability.'}</p>
            )}
          </Card>
        </div>
      )}
    </>
  )
}
