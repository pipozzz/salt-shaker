import { expect, it } from 'vitest'
import { groupKey, layout, levelCounts, levelOf, subnetOf, type Tile } from './infra'

const t = (id: string, g: Record<string, unknown>): Tile => ({ id, g })
const fleet = [
  t('web-10', { ipv4: ['127.0.0.1', '10.0.1.10'], roles: ['web', 'tls'], os: 'Ubuntu', osrelease: '24.04', virtual: 'kvm', saltversion: '3007.1' }),
  t('web-2', { ipv4: ['10.0.1.2'], roles: ['web'], os: 'Ubuntu', osrelease: '24.04', virtual: 'kvm', saltversion: '3006.9' }),
  t('db-01', { ipv4: ['10.0.2.21'], roles: ['db'], os: 'Debian', osrelease: '12.7', virtual: 'physical', saltversion: '3007.1' }),
  t('lost', {}),
]

it('groups minions by what they share', () => {
  expect(subnetOf(fleet[0].g)).toBe('10.0.1.0/24')
  expect(subnetOf(fleet[3].g)).toBe('no address')
  expect(groupKey('role', fleet[0].g)).toBe('web')
  expect(groupKey('os', fleet[2].g)).toBe('Debian 12')
  expect(groupKey('virtual', fleet[3].g)).toBe('unknown')

  expect(layout(fleet, 'subnet', 'role')).toEqual([
    { key: '10.0.1.0/24', count: 2, groups: [{ key: 'web', tiles: [fleet[1], fleet[0]] }] },
    { key: '10.0.2.0/24', count: 1, groups: [{ key: 'db', tiles: [fleet[2]] }] },
    { key: 'no address', count: 1, groups: [{ key: 'no role', tiles: [fleet[3]] }] },
  ])
  // the same grouping twice is one level
  expect(layout(fleet, 'os', 'os')[0]).toMatchObject({ key: 'Ubuntu 24', groups: [{ key: '' }] })
})

it('colours a minion by the chosen state', () => {
  const s = {
    up: new Set(['web-10', 'db-01']),
    compliance: { 'web-10': { status: 'drift' as const } },
    vulns: new Map([['db-01', { critical: 2, high: 0 }], ['web-10', { critical: 0, high: 0 }]]),
    masterVersion: '3007.1',
  }
  expect(levelOf('status', fleet[1], s)).toEqual({ level: 'critical', label: 'not answering' })
  expect(levelOf('status', fleet[1], {})).toEqual({ level: 'unknown', label: 'checking…' })
  expect(levelOf('compliance', fleet[0], s)).toEqual({ level: 'warning', label: 'drifted' })
  expect(levelOf('vulns', fleet[2], s)).toEqual({ level: 'critical', label: '2 critical' })
  expect(levelOf('vulns', fleet[0], s).level).toBe('good')
  // 3006 and 3007 are Salt's major releases
  expect(levelOf('salt', fleet[1], s)).toEqual({ level: 'critical', label: '3006.9, a major behind' })
  expect(levelOf('salt', t('x', { saltversion: '3007.0' }), s)).toEqual({ level: 'warning', label: '3007.0, not 3007.1' })
  expect(levelOf('salt', fleet[3], s).level).toBe('unknown')
  expect(levelCounts('status', fleet, s)).toEqual({ good: 2, warning: 0, critical: 2, unknown: 0 })
})
