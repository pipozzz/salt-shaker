/*
 * What a scoped user sees. A user limited to some minions (see scope.ts) gets only those minions'
 * data back: their grains and status, job returns, compliance, updates and vulnerabilities, and
 * only the events about them. Who did what (the audit log, changes and runbook runs) isn't data
 * about a minion and stays as it is.
 */

/** The minions someone may see; null for the whole fleet. */
export type Visible = ReadonlySet<string> | null

export const sees = (v: Visible, id: string) => !v || v.has(id)

const isObject = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x)

/** The entries of a record keyed by minion that are visible. */
export function pick<T>(v: Visible, rec: Record<string, T>): Record<string, T> {
  if (!v) return rec
  return Object.fromEntries(Object.entries(rec).filter(([id]) => v.has(id)))
}

/** The visible minions of a JSON list of minions (as the job table keeps it), or null when none are. */
export function visibleList(v: Visible, json: string | null): string[] | null {
  let list: unknown = null
  try {
    list = json ? JSON.parse(json) : null
  } catch {
    // not a list
  }
  return Array.isArray(list) ? list.filter((m): m is string => typeof m === 'string' && sees(v, m)) : null
}

/**
 * One bus event as a scoped user may see it: unchanged, narrowed (a new job lists only their
 * minions), or null when it is about none of them. Events that aren't about a minion (runner and
 * wheel jobs, the master's own) are left out: their data is the whole fleet's.
 */
export function visibleEvent(v: ReadonlySet<string>, tag: string, data: Record<string, unknown>): Record<string, unknown> | 'same' | null {
  if (/^salt\/job\/[^/]+\/new$/.test(tag)) {
    if (!Array.isArray(data.minions)) return null
    const minions = data.minions.filter((m): m is string => typeof m === 'string' && v.has(m))
    if (!minions.length) return null
    return minions.length === data.minions.length ? 'same' : { ...data, minions }
  }
  const job = /^salt\/job\/[^/]+\/(?:ret|prog)\/([^/]+)/.exec(tag)
  if (job) return v.has(job[1]) ? 'same' : null
  if (tag.startsWith('salt/presence/')) {
    const out: Record<string, unknown> = { ...data }
    for (const k of ['present', 'new', 'lost']) if (Array.isArray(data[k])) out[k] = (data[k] as unknown[]).filter((m) => typeof m === 'string' && v.has(m))
    return out
  }
  if (/^salt\/(job|run|wheel)\//.test(tag)) return null
  // the rest is about one minion when it names one: starts, keys, auth, beacons
  return typeof data.id === 'string' && v.has(data.id) ? 'same' : null
}

/** Runner and wheel reads whose answer is the same for everyone: files and the master's own version. */
const NOT_ABOUT_MINIONS = /^(fileserver\.(envs|file_list)|salt\.cmd)$|^(file|pillar)_roots\.(list_roots|read|list_env)$/

/** Runner and wheel reads that are narrowed to a scoped user's minions. */
const NARROWED = /^(manage\.(status|versions)|cache\.grains|jobs\.(lookup_jid|list_job|list_jobs|active)|pillar\.show_pillar|key\.(list_all|finger))$/

/**
 * Whether a scoped user may make this runner or wheel read: one whose answer is narrowed to their
 * minions, or one that isn't about minions. Returns why not, or null.
 */
export function refuseRead(v: ReadonlySet<string>, low: Record<string, unknown>): string | null {
  const fun = String(low.fun)
  if (NOT_ABOUT_MINIONS.test(fun)) return null
  if (!NARROWED.test(fun)) return `${fun} reads the whole fleet, and your access is limited to some minions`
  if (fun === 'pillar.show_pillar') {
    const minion = typeof low.minion === 'string' ? low.minion : isObject(low.kwarg) && typeof low.kwarg.minion === 'string' ? low.kwarg.minion : null
    if (!minion || !v.has(minion)) return `Outside your access: ${minion ?? "the master's pillar"}`
  }
  return null
}

/** The recorded minions of some jobs (for jobs.list_jobs, which doesn't say where a job ran). */
export type JobMinions = (jids: string[]) => Promise<Map<string, string[]>>

/**
 * A runner or wheel read's answer (as salt-api gives it), narrowed to a scoped user's minions.
 * Answers may be shared with other callers, so nothing is changed in place.
 */
export async function narrowRead(v: ReadonlySet<string>, low: Record<string, unknown>, ret: unknown, jobMinions: JobMinions): Promise<unknown> {
  const fun = String(low.fun)
  const mine = (list: unknown) => (Array.isArray(list) ? list.filter((m) => typeof m === 'string' && v.has(m)) : list)
  switch (fun) {
    case 'manage.status':
      return isObject(ret) ? { ...ret, up: mine(ret.up), down: mine(ret.down) } : ret
    case 'manage.versions':
      // {"Up to date": {web-01: "3007.1"}, ..., "Master": "3007.1"}
      return isObject(ret) ? Object.fromEntries(Object.entries(ret).map(([k, x]) => [k, isObject(x) ? pick(v, x) : x])) : ret
    case 'cache.grains':
    case 'jobs.lookup_jid': {
      if (!isObject(ret)) return ret
      // jobs with a custom outputter (state.*) come as {outputter, data}
      if ('outputter' in ret && isObject(ret.data)) return { ...ret, data: pick(v, ret.data) }
      return pick(v, ret)
    }
    case 'jobs.list_job': {
      if (!isObject(ret)) return ret
      const minions = Array.isArray(ret.Minions) ? mine(ret.Minions) : []
      const result = isObject(ret.Result) ? pick(v, ret.Result) : {}
      if (!(minions as unknown[]).length && !Object.keys(result).length) return {}
      return { ...ret, Minions: minions, Result: result }
    }
    case 'jobs.list_jobs': {
      if (!isObject(ret)) return ret
      const where = await jobMinions(Object.keys(ret))
      return Object.fromEntries(Object.entries(ret).filter(([jid]) => (where.get(jid) ?? []).some((m) => v.has(m))))
    }
    case 'jobs.active': {
      if (!isObject(ret)) return ret
      const out: Record<string, unknown> = {}
      for (const [jid, job] of Object.entries(ret)) {
        if (!isObject(job)) continue
        // Running: [{web-01: pid}], Returned: [web-02]
        const running = Array.isArray(job.Running) ? job.Running.filter((r) => isObject(r) && Object.keys(r).some((m) => v.has(m))) : []
        const returned = Array.isArray(job.Returned) ? mine(job.Returned) : []
        if (running.length || (returned as unknown[]).length) out[jid] = { ...job, Running: running, Returned: returned }
      }
      return out
    }
    case 'key.list_all':
    case 'key.finger': {
      // wheel: {tag, data: {return: {minions: [...] | {id: fp}, minions_pre, ..., local}}}
      if (!isObject(ret) || !isObject(ret.data) || !isObject(ret.data.return)) return ret
      const keys = Object.fromEntries(
        Object.entries(ret.data.return).map(([k, x]) => [k, k === 'local' ? x : Array.isArray(x) ? mine(x) : isObject(x) ? pick(v, x) : x]),
      )
      return { ...ret, data: { ...ret.data, return: keys } }
    }
    default:
      return ret
  }
}
