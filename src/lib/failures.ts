import { asStates } from './states'

/*
 * What's failing across the fleet right now: every state run's returns (state.apply, highstate,
 * state.sls, real or dry run) read newest first, keeping only failures nothing has fixed since,
 * and grouped by the state and error, so one broken repo on 40 minions is one line, not 40.
 */

export const STATE_FUNS = ['state.apply', 'state.highstate', 'state.sls'] as const

/** One minion's return from one state run. */
export interface RunReturn {
  jid: string
  fun: string
  /** as stored by the master: positional args plus a trailing {__kwarg__: true, ...}, JSON */
  args: string | null
  dryRun: boolean
  minion: string
  ret: unknown
  /** ms */
  at: number
}

export interface FailedOn {
  id: string
  jid: string
  fun: string
  dryRun: boolean
  /** ms */
  at: number
  /** the minion's own message, before it was made comparable */
  comment: string
}

export interface FailureGroup {
  key: string
  /** a state that returned False, or a run that never got to its states (render error, no sls…) */
  kind: 'state' | 'run'
  /** e.g. "service.running nginx"; for a run, what ran: "state.apply webserver.tls" */
  label: string
  /** the SLS the state is in, to run again just that */
  sls: string | null
  /** the error, with what varies per minion taken out */
  message: string
  minions: FailedOn[]
  /** ms */
  lastSeen: number
}

const parseArgs = (args: string | null): unknown[] => {
  try {
    const v = args ? JSON.parse(args) : []
    return Array.isArray(v) ? v : []
  } catch {
    return []
  }
}

/** The SLS a run applied ('' for the highstate) and whether it was a dry run, from its arguments. */
export function runSls(fun: string, args: string | null) {
  const list = parseArgs(args)
  const kw = list.find((a): a is Record<string, unknown> => !!a && typeof a === 'object' && !Array.isArray(a) && '__kwarg__' in a) ?? {}
  const pos = list.filter((a) => typeof a === 'string' && !a.includes('=')) as string[]
  const fromKw = typeof kw.mods === 'string' ? kw.mods : ''
  const sls = fun === 'state.highstate' ? '' : (pos[0] ?? fromKw)
  return sls
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .sort()
    .join(',')
}

/** "service.running nginx" for `service_|-nginx_|-nginx_|-running`. */
export function stateName(key: string) {
  const [mod, id, name, fun] = key.split('_|-')
  return `${mod}.${fun} ${name || id}`
}

/** The first line that says something, with what differs between minions taken out. */
export function normalizeMessage(text: string, minion: string) {
  const line =
    text
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l && !/^-+$/.test(l)) ?? ''
  let s = line
  if (minion) s = s.split(minion).join('<minion>')
  s = s
    .replace(/\b\d{1,3}(\.\d{1,3}){3}\b/g, '<ip>')
    .replace(/\b[0-9a-f]{12,}\b/gi, '<id>')
    .replace(/\b\d{4,}\b/g, 'N')
    .replace(/\s+/g, ' ')
  return s.length > 300 ? `${s.slice(0, 299)}…` : s
}

/** A return that isn't states: the run stopped before applying any (or the function errored). */
function runError(ret: unknown): string | null {
  if (Array.isArray(ret) && ret.length && ret.every((x) => typeof x === 'string')) return ret.join('\n')
  if (typeof ret === 'string' && ret.trim()) return ret
  if (ret === false) return 'The run returned False'
  return null
}

/**
 * Failures nothing has fixed since, grouped, the most widespread first. A failed state counts
 * until a later run on that minion has the same state succeed; a run that never got to its states
 * counts until the same run (same SLS) gets through, or a later highstate does.
 */
export function failureGroups(returns: RunReturn[]): FailureGroup[] {
  const byMinion = new Map<string, RunReturn[]>()
  for (const r of returns) {
    const list = byMinion.get(r.minion) ?? []
    list.push(r)
    byMinion.set(r.minion, list)
  }
  const groups = new Map<string, FailureGroup>()
  const add = (g: Omit<FailureGroup, 'minions' | 'lastSeen'>, on: FailedOn) => {
    let group = groups.get(g.key)
    if (!group) {
      group = { ...g, minions: [], lastSeen: 0 }
      groups.set(g.key, group)
    }
    group.minions.push(on)
    group.lastSeen = Math.max(group.lastSeen, on.at)
  }

  for (const [minion, runs] of byMinion) {
    runs.sort((a, b) => b.at - a.at)
    // states and runs a newer return already settled, for or against
    const settledStates = new Set<string>()
    const settledRuns = new Set<string>()
    let highstateOk = false
    for (const r of runs) {
      const sls = runSls(r.fun, r.args)
      const runKey = sls || '<highstate>'
      const states = asStates(r.ret)
      if (states) {
        for (const [key, st] of states) {
          if (settledStates.has(key)) continue
          settledStates.add(key)
          if (st.result !== false) continue
          const label = stateName(key)
          const comment = String(st.comment ?? '')
          const message = normalizeMessage(comment, minion) || 'Failed, with no comment'
          add({ key: `state|${label}|${message}`, kind: 'state', label, sls: st.__sls__ ?? null, message }, { id: minion, jid: r.jid, fun: r.fun, dryRun: r.dryRun, at: r.at, comment })
        }
        if (!settledRuns.has(runKey)) settledRuns.add(runKey)
        if (!sls && !states.some(([, st]) => st.result === false)) highstateOk = true
        continue
      }
      const err = runError(r.ret)
      if (settledRuns.has(runKey) || highstateOk) continue
      settledRuns.add(runKey)
      if (!err) continue
      const label = `${r.fun === 'state.highstate' ? 'state.highstate' : 'state.apply'}${sls ? ` ${sls}` : ''}`
      const message = normalizeMessage(err, minion) || 'Failed'
      add({ key: `run|${label}|${message}`, kind: 'run', label, sls: sls || null, message }, { id: minion, jid: r.jid, fun: r.fun, dryRun: r.dryRun, at: r.at, comment: err })
    }
  }

  const collate = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true })
  return [...groups.values()]
    .map((g) => ({ ...g, minions: g.minions.sort((a, b) => collate(a.id, b.id)) }))
    .sort((a, b) => b.minions.length - a.minions.length || b.lastSeen - a.lastSeen || collate(a.label, b.label))
}

/** How to run it again on those minions: the SLS the state is in, or the run that stopped. */
export function rerunArgs(g: Pick<FailureGroup, 'sls'>, dryRun = false) {
  const parts = g.sls ? [g.sls] : []
  if (dryRun) parts.push('test=True')
  return parts.join(' ')
}
