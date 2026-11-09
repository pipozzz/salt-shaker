/*
 * Package version ordering, to tell whether an available upgrade reaches the version a
 * vulnerability is fixed in. dpkg's rules for Debian, Ubuntu (and, close enough, Alpine);
 * rpm's for AlmaLinux and Rocky Linux.
 */

const isDigit = (c: string) => c >= '0' && c <= '9'
const isAlpha = (c: string) => /[A-Za-z]/.test(c)

/** dpkg's order for one non-digit character: ~ before everything, even the end; letters before the rest */
function dpkgOrder(c: string | undefined): number {
  if (c === undefined || isDigit(c)) return 0
  if (c === '~') return -1
  if (isAlpha(c)) return c.charCodeAt(0)
  return c.charCodeAt(0) + 256
}

function dpkgPart(a: string, b: string): number {
  let i = 0
  let j = 0
  while (i < a.length || j < b.length) {
    let first = 0
    while ((i < a.length && !isDigit(a[i])) || (j < b.length && !isDigit(b[j]))) {
      const d = dpkgOrder(a[i]) - dpkgOrder(b[j])
      if (d) return d
      i++
      j++
    }
    while (a[i] === '0') i++
    while (b[j] === '0') j++
    while (i < a.length && isDigit(a[i]) && j < b.length && isDigit(b[j])) {
      if (!first) first = a.charCodeAt(i) - b.charCodeAt(j)
      i++
      j++
    }
    if (i < a.length && isDigit(a[i])) return 1
    if (j < b.length && isDigit(b[j])) return -1
    if (first) return first
  }
  return 0
}

function split(v: string): [epoch: number, upstream: string, revision: string] {
  const m = /^(?:(\d+):)?(.+?)(?:-([^-]+))?$/.exec(v.trim())
  return m ? [Number(m[1] ?? 0), m[2], m[3] ?? ''] : [0, v, '']
}

export function compareDpkg(a: string, b: string): number {
  const [ea, ua, ra] = split(a)
  const [eb, ub, rb] = split(b)
  return Math.sign(ea - eb || dpkgPart(ua, ub) || dpkgPart(ra, rb))
}

/** rpmvercmp: alternating runs of digits and letters; digits beat letters, ~ sorts first, ^ after the end */
function rpmPart(a: string, b: string): number {
  if (a === b) return 0
  let i = 0
  let j = 0
  for (;;) {
    while (i < a.length && !/[A-Za-z0-9~^]/.test(a[i])) i++
    while (j < b.length && !/[A-Za-z0-9~^]/.test(b[j])) j++
    if (a[i] === '~' || b[j] === '~') {
      if (a[i] !== '~') return 1
      if (b[j] !== '~') return -1
      i++
      j++
      continue
    }
    if (a[i] === '^' || b[j] === '^') {
      if (i >= a.length) return -1
      if (j >= b.length) return 1
      if (a[i] !== '^') return 1
      if (b[j] !== '^') return -1
      i++
      j++
      continue
    }
    if (i >= a.length || j >= b.length) break
    const numeric = isDigit(a[i])
    const run = numeric ? /^\d+/ : /^[A-Za-z]+/
    const sa = run.exec(a.slice(i))?.[0] ?? ''
    const sb = run.exec(b.slice(j))?.[0] ?? ''
    if (!sb) return numeric ? 1 : -1
    i += sa.length
    j += sb.length
    if (numeric) {
      const na = sa.replace(/^0+/, '')
      const nb = sb.replace(/^0+/, '')
      if (na.length !== nb.length) return na.length > nb.length ? 1 : -1
      if (na !== nb) return na > nb ? 1 : -1
    } else if (sa !== sb) return sa > sb ? 1 : -1
  }
  if (i >= a.length && j >= b.length) return 0
  return i >= a.length ? -1 : 1
}

export function compareRpm(a: string, b: string): number {
  const [ea, va, ra] = split(a)
  const [eb, vb, rb] = split(b)
  return Math.sign(ea - eb || rpmPart(va, vb) || rpmPart(ra, rb))
}

/** Compares two versions the way the ecosystem's package manager does (an OSV ecosystem such as "Debian:12"). */
export function compareVersions(ecosystem: string | null, a: string, b: string): number {
  return /^(AlmaLinux|Rocky Linux|Red Hat)/.test(ecosystem ?? '') ? compareRpm(a, b) : compareDpkg(a, b)
}
