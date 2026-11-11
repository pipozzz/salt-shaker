/*
 * Two minions side by side: their grains flattened to dotted keys, and their installed packages,
 * keeping what differs. Some grains always differ between two machines (their names, addresses,
 * ids); those are set apart so they don't hide what matters.
 */

export type Flat = Record<string, string>

/** {"os": "Debian", "ip4_interfaces": {"eth0": ["10.0.0.1"]}} → {"os": "Debian", "ip4_interfaces.eth0": "10.0.0.1"} */
export function flatten(value: unknown, prefix = '', out: Flat = {}): Flat {
  if (Array.isArray(value)) {
    // short lists of plain values read best as one line
    if (value.every((v) => v === null || typeof v !== 'object')) out[prefix] = value.map(String).join(', ')
    else value.forEach((v, i) => flatten(v, `${prefix}[${i}]`, out))
  } else if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
    if (!entries.length && prefix) out[prefix] = '{}'
    for (const [k, v] of entries) flatten(v, prefix ? `${prefix}.${k}` : k, out)
  } else if (prefix) out[prefix] = value === null || value === undefined ? '' : String(value)
  return out
}

/** Grains that tell any two machines apart, whatever their setup. */
const IDENTITY = /^(id|host|nodename|fqdn|localhost|domain|machine_id|uid|gid|pid|server_id|serialnumber|uuid|biosversion|boot_id|hwaddr_interfaces|ipv4|ipv6|ip_interfaces|ip4_interfaces|ip6_interfaces|fqdn_ip4|fqdn_ip6|fqdns|dns|master|mem_total|swap_total|uptime|cwd)\b/

export const isIdentity = (key: string) => IDENTITY.test(key)

export interface Row {
  key: string
  a: string | null
  b: string | null
}

/** The keys whose values differ (or that only one side has), sorted; identity grains apart. */
export function diffFlat(a: Flat, b: Flat): { differ: Row[]; identity: Row[]; same: number } {
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()
  const differ: Row[] = []
  const identity: Row[] = []
  let same = 0
  for (const key of keys) {
    const x = key in a ? a[key] : null
    const y = key in b ? b[key] : null
    if (x === y) same++
    else (isIdentity(key) ? identity : differ).push({ key, a: x, b: y })
  }
  return { differ, identity, same }
}

export interface PackageRow {
  name: string
  a: string | null
  b: string | null
}

/** Packages with a different version on each, or on only one of them. */
export function diffPackages(a: Array<{ name: string; version: string }>, b: Array<{ name: string; version: string }>): { differ: PackageRow[]; same: number } {
  const va = new Map(a.map((p) => [p.name, p.version]))
  const vb = new Map(b.map((p) => [p.name, p.version]))
  const names = [...new Set([...va.keys(), ...vb.keys()])].sort()
  const differ: PackageRow[] = []
  let same = 0
  for (const name of names) {
    const x = va.get(name) ?? null
    const y = vb.get(name) ?? null
    if (x === y) same++
    else differ.push({ name, a: x, b: y })
  }
  return { differ, same }
}
