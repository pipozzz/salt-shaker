/** Functions that change minions (or can, like cmd.*). Dry runs (test=True) don't count. */
const RISKY =
  /^(cmd\.|state\.(apply|highstate|sls|single|sls_id)$|pkg\.(install|remove|purge|upgrade|refresh_db)$|service\.(restart|stop|disable|reload)$|system\.(reboot|shutdown|halt|poweroff)$|file\.(remove|write|replace|append|rename)$|user\.(add|delete)$|group\.(add|delete)$|saltutil\.(kill_job|term_job|signal_job)$|cp\.)/

export function isRisky(fun: string, args: string) {
  return RISKY.test(fun.trim()) && !/(^|\s)test=(True|true)(\s|$)/.test(args)
}

/** Above this many minions, the user must type the count to confirm. */
export const TYPE_TO_CONFIRM_AT = 5

/**
 * How much friction a run needs: none, a confirm dialog, or typing the minion count.
 * `matched` is null when the target preview is unknown (e.g. no cache.grains permission).
 */
export function confirmLevel(fun: string, args: string, matched: string[] | null): 'none' | 'confirm' | 'type' {
  if (!isRisky(fun, args)) return 'none'
  if (matched === null) return 'confirm'
  if (matched.length >= TYPE_TO_CONFIRM_AT) return 'type'
  return matched.length > 1 ? 'confirm' : 'none'
}
