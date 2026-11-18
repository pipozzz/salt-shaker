/**
 * Salt's event `_stamp`, always UTC: older masters send it without a zone ("2026-11-18T12:49:14.123456"),
 * newer ones with one ("…+00:00"). Null if it can't be read.
 */
export function parseSaltStamp(s: unknown): Date | null {
  if (typeof s !== 'string' || !s) return null
  const d = new Date(/(Z|[+-]\d{2}:?\d{2})$/i.test(s) ? s : `${s}Z`)
  return Number.isNaN(d.getTime()) ? null : d
}
