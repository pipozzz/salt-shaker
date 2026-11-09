import { describe, expect, it } from 'vitest'
import { compareDpkg, compareRpm, compareVersions } from './pkgversion'

describe('compareDpkg', () => {
  it.each([
    ['1.0', '1.0', 0],
    ['1.0-1', '1.0-2', -1],
    ['1.10', '1.9', 1],
    ['1.0~rc1', '1.0', -1],
    ['1.0', '1.0+deb12u1', -1],
    ['1:1.0', '2.0', 1],
    ['3.0.13-0ubuntu3.5', '3.0.13-0ubuntu3.4', 1],
    ['1:1.3.dfsg+really1.3.1-1+deb13u1', '1:1.3.dfsg+really1.3.1-1+b1', 1],
    ['1:1.3.dfsg+really1.3.1-1+b1', '1:1.3.dfsg+really1.3.1-1+deb13u1', -1],
    ['7.88.1-10+deb12u9', '7.88.1-10+deb12u10', -1],
    ['1.2-3-4', '1.2-3-5', -1],
    ['1.0a', '1.0', 1],
    ['1.0.0', '1.0', 1],
    ['3.3.2-r1', '3.3.2-r2', -1],
  ])('%s vs %s', (a, b, want) => expect(compareDpkg(a, b)).toBe(want))
})

describe('compareRpm', () => {
  it.each([
    ['7.76.1-31.el9', '7.76.1-29.el9_4', 1],
    ['1.9.5p2-10.el9_5', '1.9.5p2-10.el9_3', 1],
    ['5.14.0-503.14.1.el9_5', '5.14.0-503.11.1.el9_5', 1],
    ['1.0', '1.0', 0],
    ['1.0~rc1', '1.0', -1],
    ['1.0^git1', '1.0', 1],
    ['1.0a', '1.0.1', -1],
    ['2:1.0', '1:9.0', 1],
    ['1.010', '1.9', 1],
  ])('%s vs %s', (a, b, want) => expect(compareRpm(a, b)).toBe(want))
})

it('picks the ordering by ecosystem', () => {
  expect(compareVersions('Rocky Linux:9', '1.0+1', '1.0.1')).toBe(0)
  expect(compareVersions('Debian:12', '1.0+1', '1.0.1')).toBe(-1)
})
