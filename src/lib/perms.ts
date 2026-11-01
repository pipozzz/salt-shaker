/**
 * Evaluates the eauth permission list salt-api returns at login, e.g.
 *   ['grains.*', {'web*': ['state.apply']}, '@wheel', {'@runner': ['jobs.*']}]
 * The master is the real gatekeeper; this only lets the UI hide or disable what would fail.
 */
export type PermClient = 'local' | 'runner' | 'wheel'

type Entry = string | Record<string, unknown>

const matches = (pattern: string, fun: string) => {
  try {
    return new RegExp(`^(?:${pattern})$`).test(fun)
  } catch {
    return pattern === fun
  }
}

// a function list entry is either "mod.fun" or {"mod.fun": {args/kwargs constraints}}
const funsMatch = (list: unknown, fun: string) =>
  Array.isArray(list) && list.some((f) => (typeof f === 'string' ? matches(f, fun) : !!f && typeof f === 'object' && Object.keys(f).some((k) => matches(k, fun))))

export function makeCan(perms: unknown[] | undefined) {
  // no perms reported (or an admin wildcard) means we cannot know better than the master
  if (!Array.isArray(perms)) return () => true
  const entries = perms as Entry[]

  return (client: PermClient, fun: string) => {
    if (client === 'local') {
      return entries.some((e) =>
        typeof e === 'string'
          ? !e.startsWith('@') && matches(e, fun)
          : Object.entries(e).some(([tgt, funs]) => !tgt.startsWith('@') && funsMatch(funs, fun)),
      )
    }
    const group = `@${client}`
    // @jobs grants the jobs.* runners
    if (client === 'runner' && fun.startsWith('jobs.') && entries.includes('@jobs')) return true
    return entries.some((e) => (typeof e === 'string' ? e === group : group in e && funsMatch(e[group], fun)))
  }
}

export type Can = ReturnType<typeof makeCan>
