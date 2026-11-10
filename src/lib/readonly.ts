/** salt-api clients by the kind of function they run. */
export const CLIENT_KINDS = { local: 'local', local_async: 'local', runner: 'runner', runner_async: 'runner', wheel: 'wheel' } as const
export type ClientKind = (typeof CLIENT_KINDS)[keyof typeof CLIENT_KINDS]

/** Calls that only read. Everything else is written to the audit log (by the server, and in the demo). */
export const READ_ONLY: Record<ClientKind, RegExp> = {
  local: /^(test\.(ping|version)|grains\.(items|item|get|ls)|pillar\.(items|item|get)|sys\.\w+|saltutil\.find_job|pkg\.(list_upgrades|version|list_pkgs)|status\.\w+|disk\.usage|network\.(ip_addrs|interfaces)|service\.status|state\.show_\w+)$/,
  runner: /^(manage\.(status|versions)|cache\.grains|jobs\.\w+|pillar\.show_pillar|salt\.cmd)$/,
  wheel: /^(key\.(list_all|finger)|(file|pillar)_roots\.(list_roots|read|list_env))$/,
}

/** Whether a call goes in the audit log: anything that isn't a known read. */
export function isAudited(client: string, fun: string) {
  const kind = CLIENT_KINDS[client as keyof typeof CLIENT_KINDS]
  return !kind || !READ_ONLY[kind].test(fun)
}
