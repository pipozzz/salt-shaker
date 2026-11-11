import { describe, expect, it } from 'vitest'
import { diffFlat, diffPackages, flatten } from './compare'

describe('compare', () => {
  it('flattens grains to dotted keys', () => {
    expect(flatten({ os: 'Debian', roles: ['web', 'nginx'], ip4_interfaces: { eth0: ['10.0.0.1'] }, disks: [{ name: 'sda', size: 10 }], empty: {} })).toEqual({
      os: 'Debian',
      roles: 'web, nginx',
      'ip4_interfaces.eth0': '10.0.0.1',
      'disks[0].name': 'sda',
      'disks[0].size': '10',
      empty: '{}',
    })
  })

  it('keeps what differs, with the grains that always differ set apart', () => {
    const d = diffFlat({ id: 'web-01', os: 'Debian', osrelease: '12', saltversion: '3007.1', roles: 'web' }, { id: 'web-02', os: 'Debian', osrelease: '11', saltversion: '3007.1', kernel: 'Linux' })
    expect(d.differ).toEqual([
      { key: 'kernel', a: null, b: 'Linux' },
      { key: 'osrelease', a: '12', b: '11' },
      { key: 'roles', a: 'web', b: null },
    ])
    expect(d.identity).toEqual([{ key: 'id', a: 'web-01', b: 'web-02' }])
    expect(d.same).toBe(2)
  })

  it('lists packages that differ in version or are only on one side', () => {
    expect(diffPackages([{ name: 'nginx', version: '1.24' }, { name: 'bash', version: '5.2' }], [{ name: 'nginx', version: '1.26' }, { name: 'bash', version: '5.2' }, { name: 'curl', version: '8' }])).toEqual({
      differ: [
        { name: 'curl', a: null, b: '8' },
        { name: 'nginx', a: '1.24', b: '1.26' },
      ],
      same: 1,
    })
  })
})
