/** How many minions go in a batch: "25%" of them, a number, or all at once. */
export function batchCount(size: string | null | undefined, total: number) {
  const s = (size ?? '').trim()
  if (!s || total === 0) return Math.max(1, total)
  const pct = /^(\d+(?:\.\d+)?)%$/.exec(s)
  const n = pct ? Math.ceil((total * Number(pct[1])) / 100) : Number(s)
  return Number.isFinite(n) && n >= 1 ? Math.min(total, Math.floor(n)) : total
}

export const validBatchSize = (s: string) => !s.trim() || /^(\d+|\d+(\.\d+)?%)$/.test(s.trim())
