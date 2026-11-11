/** The weekly report's numbers and how they read (shared by the server and the demo). */

export interface ReportMessage {
  title: string
  lines: string[]
  severity: 'info' | 'warning' | 'error'
  path?: string
}

const QUIET_DAYS = 30

export interface ReportStats {
  from: Date
  to: Date
  minions: { accepted: number; notAnswering: number | null; quiet: number | null }
  jobs: { run: number; failed: number }
  changes: { done: number; stopped: number; waiting: number }
  vulns: { critical: number; high: number; fixable: number; criticalBefore: number | null; highBefore: number | null } | null
  commands: { count: number; people: number }
}

const n = (k: number, one: string, many = `${one}s`) => `${k} ${k === 1 ? one : many}`
const delta = (now: number, before: number | null) => (before === null || before === now ? '' : ` (${now > before ? '+' : '−'}${Math.abs(now - before)})`)

export function reportMessage(s: ReportStats): ReportMessage {
  const m = s.minions
  const minionBits = [`${m.accepted} accepted`]
  if (m.notAnswering) minionBits.push(`${m.notAnswering} not answering`)
  if (m.quiet) minionBits.push(`${m.quiet} quiet for ${QUIET_DAYS}+ days`)
  const changeBits = [
    ...(s.changes.done ? [`${s.changes.done} rolled out`] : []),
    ...(s.changes.stopped ? [`${s.changes.stopped} stopped or failed`] : []),
    ...(s.changes.waiting ? [`${s.changes.waiting} waiting for approval`] : []),
  ]
  const v = s.vulns
  const title = [n(m.accepted, 'minion'), `${n(s.jobs.failed, 'failed job')}`, ...(v ? [`${v.critical} critical ${v.critical === 1 ? 'vulnerability' : 'vulnerabilities'}`] : [])].join(', ')
  const days = (d: Date) => d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
  return {
    title: `Weekly report: ${title}`,
    lines: [
      `${days(s.from)} – ${days(s.to)}`,
      `Minions: ${minionBits.join(', ')}`,
      `Jobs: ${s.jobs.run} run, ${s.jobs.failed} failed`,
      ...(changeBits.length ? [`Changes: ${changeBits.join(', ')}`] : []),
      ...(v ? [`Vulnerabilities: ${v.critical} critical${delta(v.critical, v.criticalBefore)}, ${v.high} high${delta(v.high, v.highBefore)}, ${v.fixable} with a fix`] : []),
      `Commands from the console and API: ${s.commands.count}, by ${n(s.commands.people, 'person', 'people')}`,
    ],
    severity: s.jobs.failed || v?.critical || m.notAnswering ? 'warning' : 'info',
    path: '/',
  }
}

