/** Small display helpers shared by several pages. */

/** "5m ago", "3h ago", or a date for anything older than a day. */
export function relTime(d: Date | null) {
  if (!d) return '—'
  const s = Math.round((Date.now() - d.getTime()) / 1000)
  if (s < 60) return `${Math.max(s, 0)}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return d.toLocaleDateString()
}

/** Badge tone for a Salt function by module. */
export function funTone(fun: string) {
  if (fun.startsWith('state.')) return 'accent' as const
  if (fun.startsWith('cmd.')) return 'amber' as const
  if (fun.startsWith('test.')) return 'zinc' as const
  return 'blue' as const
}

/** Megabytes from grains (mem_total) as MB or GB. */
export const fmtMem = (mb?: number) => (mb ? (mb >= 1024 ? `${Math.round(mb / 1024)} GB` : `${mb} MB`) : '—')
