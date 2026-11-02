import type { Grains } from '../api/types'

/** The grains the fleet views use; everything else stays on the master. */
export const FLEET_GRAINS = [
  'id',
  'host',
  'fqdn',
  'os',
  'os_family',
  'osrelease',
  'osfinger',
  'kernel',
  'kernelrelease',
  'cpu_model',
  'num_cpus',
  'mem_total',
  'ipv4',
  'saltversion',
  'roles',
  'virtual',
] as const

/** Keeps only FLEET_GRAINS of each minion; non-object entries (errors) are dropped. */
export function trimFleet(all: Record<string, unknown>): Record<string, Grains> {
  const out: Record<string, Grains> = {}
  for (const [id, g] of Object.entries(all ?? {})) {
    if (!g || typeof g !== 'object' || Array.isArray(g)) continue
    const src = g as Record<string, unknown>
    const kept: Record<string, unknown> = {}
    for (const k of FLEET_GRAINS) if (k in src) kept[k] = src[k]
    out[id] = kept as Grains
  }
  return out
}
