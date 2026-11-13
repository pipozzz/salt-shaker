/*
 * A line diff of two short texts (a runbook as YAML is a few dozen lines), for showing what a
 * version changed: the longest common subsequence of lines, then the lines around each change.
 */

export type DiffLine = { kind: 'same' | 'add' | 'del'; text: string }

export function lineDiff(before: string, after: string): DiffLine[] {
  const a = before.split('\n')
  const b = after.split('\n')
  // lcs[i][j]: the longest common subsequence of a[i..] and b[j..]
  const lcs = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0))
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1])
  const out: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ kind: 'same', text: a[i] })
      i++
      j++
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) out.push({ kind: 'del', text: a[i++] })
    else out.push({ kind: 'add', text: b[j++] })
  }
  while (i < a.length) out.push({ kind: 'del', text: a[i++] })
  while (j < b.length) out.push({ kind: 'add', text: b[j++] })
  return out
}

/** The changed lines with `context` lines around them; a gap between is null. */
export function aroundChanges(lines: DiffLine[], context = 2): Array<DiffLine | null> {
  const keep = lines.map(() => false)
  lines.forEach((l, i) => {
    if (l.kind !== 'same') for (let k = Math.max(0, i - context); k <= Math.min(lines.length - 1, i + context); k++) keep[k] = true
  })
  const out: Array<DiffLine | null> = []
  lines.forEach((l, i) => {
    if (keep[i]) out.push(l)
    else if (out.length && out.at(-1) !== null) out.push(null)
  })
  if (out.at(-1) === null) out.pop()
  return out
}
