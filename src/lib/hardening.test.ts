import { expect, it } from 'vitest'
import { CHECKS, evidenceCsv, hardeningSql, isHardeningSql, readMinion, summarize } from './hardening'

const answer = (fails: string[]) => JSON.stringify(CHECKS.map((c) => ({ id: c.id, pass: fails.includes(c.id) ? 0 : 1 })))

it('runs every check in one query, a row per check', () => {
  const sql = hardeningSql()
  expect(isHardeningSql(sql)).toBe(true)
  expect(isHardeningSql('SELECT * FROM users')).toBe(false)
  expect(sql.match(/UNION ALL/g)).toHaveLength(CHECKS.length - 1)
  expect(new Set(CHECKS.map((c) => c.id)).size).toBe(CHECKS.length)
  // quotes inside a check would end its id early
  for (const c of CHECKS) expect(c.id).toMatch(/^[a-z0-9-]+$/)
})

it('scores each minion and lists who fails which check', () => {
  expect(readMinion(answer([]))).toMatchObject({ score: 100 })
  expect(readMinion(answer(['auditd', 'tmp-mount', 'aslr']))).toMatchObject({ score: 80 })
  expect(readMinion("ERROR: Unable to run command '['osqueryi', '--json']', reason: [Errno 2] No such file or directory: 'osqueryi'")).toEqual({ error: 'osquery is not installed', missing: true })
  expect(readMinion('[]')).toEqual({ error: 'The answer had none of the checks' })

  const s = summarize({ b: answer(['auditd']), a: answer(['auditd', 'tmp-mount', 'aslr']), c: "osqueryi: command not found", d: 'Error: no such table: augeas' })
  expect(s.minions).toEqual([
    { id: 'a', score: 80, failed: ['tmp-mount', 'aslr', 'auditd'] },
    { id: 'b', score: 93, failed: ['auditd'] },
  ])
  expect(s.score).toBe(87)
  expect(s.missing).toEqual(['c'])
  expect(s.errors).toEqual([{ minion: 'd', error: 'Error: no such table: augeas' }])
  expect(s.checks.find((c) => c.id === 'auditd')).toMatchObject({ pass: [], fail: ['a', 'b'] })

  const csv = evidenceCsv(s, { jid: '2026', at: '2026-11-11T10:00:00Z' }).split('\n')
  expect(csv[0]).toBe('minion,check,area,title,result,checked_at,jid')
  expect(csv).toContain('a,auditd,Services,auditd is running,fail,2026-11-11T10:00:00Z,2026')
  expect(csv).toContain('c,,,,no osquery,2026-11-11T10:00:00Z,2026')
  expect(csv.length).toBe(2 * CHECKS.length + 2 + 2)
})
