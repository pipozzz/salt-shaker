import { csvCell } from './csv'
import { parseOsquery } from './osquery'

/*
 * Hardening checks: common Linux hardening recommendations (the kind CIS benchmarks make), each
 * one an osquery expression that is 1 when the minion passes. All of them go to a minion as one
 * query, so a check of the fleet is one cmd.run. Not a certified CIS benchmark: a quick, readable
 * baseline whose results can be kept as evidence.
 */

export interface Check {
  id: string
  area: 'SSH' | 'Accounts' | 'Files' | 'Network' | 'Kernel' | 'Services'
  title: string
  /** why it matters, and what to do about it */
  why: string
  /** an osquery (SQLite) expression: 1 passes, 0 fails */
  sql: string
}

const sshd = (label: string) => `SELECT lower(value) FROM augeas WHERE path = '/etc/ssh/sshd_config' AND label = '${label}'`
const sysctl = (name: string, value: string) => `EXISTS (SELECT 1 FROM system_controls WHERE name = '${name}' AND current_value = '${value}')`

export const CHECKS: Check[] = [
  {
    id: 'ssh-root-login',
    area: 'SSH',
    title: 'Root can’t log in with a password over SSH',
    why: 'PermitRootLogin is no or prohibit-password (the default), so a guessed root password isn’t enough.',
    sql: `NOT EXISTS (${sshd('PermitRootLogin')} AND lower(value) NOT IN ('no', 'prohibit-password', 'without-password'))`,
  },
  {
    id: 'ssh-password-auth',
    area: 'SSH',
    title: 'SSH takes keys, not passwords',
    why: 'PasswordAuthentication no in sshd_config: passwords can be guessed and reused, keys can’t.',
    sql: `EXISTS (${sshd('PasswordAuthentication')} AND lower(value) = 'no')`,
  },
  {
    id: 'ssh-x11',
    area: 'SSH',
    title: 'No X11 forwarding over SSH',
    why: 'X11Forwarding is not yes: servers rarely need it, and it lets the server reach the client’s display.',
    sql: `NOT EXISTS (${sshd('X11Forwarding')} AND lower(value) = 'yes')`,
  },
  {
    id: 'uid0-root-only',
    area: 'Accounts',
    title: 'Only root has user id 0',
    why: 'Another account with uid 0 is root under another name, and often a sign of tampering.',
    sql: `(SELECT count(*) FROM users WHERE uid = 0) = 1`,
  },
  {
    id: 'shadow-perms',
    area: 'Files',
    title: '/etc/shadow is readable by root only',
    why: 'Mode 0640 or stricter, owned by root: the password hashes stay out of other users’ reach.',
    sql: `EXISTS (SELECT 1 FROM file WHERE path = '/etc/shadow' AND uid = 0 AND mode IN ('0000', '0400', '0600', '0640'))`,
  },
  {
    id: 'passwd-perms',
    area: 'Files',
    title: '/etc/passwd isn’t writable by others',
    why: 'Mode 0644 or stricter, owned by root: anyone who can write it can make themselves root.',
    sql: `EXISTS (SELECT 1 FROM file WHERE path = '/etc/passwd' AND uid = 0 AND mode IN ('0644', '0444', '0640', '0600'))`,
  },
  {
    id: 'suid-in-tmp',
    area: 'Files',
    title: 'No setuid programs in temporary directories',
    why: 'A setuid binary in /tmp, /var/tmp or /dev/shm is almost always a planted backdoor.',
    sql: `NOT EXISTS (SELECT 1 FROM suid_bin WHERE path LIKE '/tmp/%' OR path LIKE '/var/tmp/%' OR path LIKE '/dev/shm/%')`,
  },
  {
    id: 'tmp-mount',
    area: 'Files',
    title: '/tmp is its own filesystem',
    why: 'A separate /tmp (tmpfs or a partition) can be mounted noexec and can’t fill the root filesystem.',
    sql: `EXISTS (SELECT 1 FROM mounts WHERE path = '/tmp')`,
  },
  {
    id: 'ip-forward',
    area: 'Network',
    title: 'Doesn’t route packets',
    why: 'net.ipv4.ip_forward is 0 unless the machine is a router or runs containers (which need it).',
    sql: sysctl('net.ipv4.ip_forward', '0'),
  },
  {
    id: 'icmp-redirects',
    area: 'Network',
    title: 'Ignores ICMP redirects',
    why: 'net.ipv4.conf.all.accept_redirects is 0, so no one on the network can reroute its traffic.',
    sql: sysctl('net.ipv4.conf.all.accept_redirects', '0'),
  },
  {
    id: 'syn-cookies',
    area: 'Network',
    title: 'SYN cookies are on',
    why: 'net.ipv4.tcp_syncookies is 1, which keeps connections working during a SYN flood.',
    sql: sysctl('net.ipv4.tcp_syncookies', '1'),
  },
  {
    id: 'legacy-services',
    area: 'Services',
    title: 'No telnet, FTP, TFTP or r-services listening',
    why: 'Nothing listens on ports 21, 23, 69 or 512–514: these send passwords and data in clear text.',
    sql: `NOT EXISTS (SELECT 1 FROM listening_ports WHERE port IN (21, 23, 69, 512, 513, 514))`,
  },
  {
    id: 'aslr',
    area: 'Kernel',
    title: 'Address space layout randomization is full',
    why: 'kernel.randomize_va_space is 2, which makes memory corruption bugs much harder to exploit.',
    sql: sysctl('kernel.randomize_va_space', '2'),
  },
  {
    id: 'auditd',
    area: 'Services',
    title: 'auditd is running',
    why: 'The kernel audit log records logins, privilege changes and access to sensitive files.',
    sql: `EXISTS (SELECT 1 FROM processes WHERE name = 'auditd')`,
  },
  {
    id: 'time-sync',
    area: 'Services',
    title: 'The clock is kept in sync',
    why: 'chrony, ntpd or systemd-timesyncd runs: logs from different machines only line up with the right time.',
    sql: `EXISTS (SELECT 1 FROM processes WHERE name IN ('chronyd', 'ntpd', 'ntpsec', 'systemd-timesyn', 'openntpd'))`,
  },
]

/** Tells a hardening query apart from others (the demo answers it). */
export const isHardeningSql = (sql: string) => /^SELECT '[a-z0-9-]+' AS id, CASE WHEN /.test(sql.trim())

/** The one query that runs every check on a minion: a row per check with pass 1 or 0. */
export function hardeningSql(checks: Check[] = CHECKS) {
  return checks.map((c) => `SELECT '${c.id}' AS id, CASE WHEN ${c.sql} THEN 1 ELSE 0 END AS pass`).join('\nUNION ALL\n')
}

export type MinionResult = { passed: Record<string, boolean>; score: number } | { error: string; missing?: boolean }

/** One minion's cmd.run return: which checks it passes, or why it couldn't run them. */
export function readMinion(ret: unknown, checks: Check[] = CHECKS): MinionResult {
  const res = parseOsquery(ret)
  if (!('rows' in res)) return res
  const passed: Record<string, boolean> = {}
  for (const row of res.rows) if (row.id) passed[row.id] = String(row.pass) === '1'
  const known = checks.filter((c) => c.id in passed)
  if (!known.length) return { error: 'The answer had none of the checks' }
  return { passed, score: Math.round((100 * known.filter((c) => passed[c.id]).length) / known.length) }
}

export interface Summary {
  minions: Array<{ id: string; score: number; failed: string[] }>
  checks: Array<Check & { pass: string[]; fail: string[] }>
  missing: string[]
  errors: Array<{ minion: string; error: string }>
  /** the average score over the minions that ran the checks */
  score: number | null
}

export function summarize(results: Record<string, unknown>, checks: Check[] = CHECKS): Summary {
  const out: Summary = { minions: [], checks: checks.map((c) => ({ ...c, pass: [], fail: [] })), missing: [], errors: [], score: null }
  for (const [minion, ret] of Object.entries(results).sort((a, b) => a[0].localeCompare(b[0]))) {
    const r = readMinion(ret, checks)
    if ('error' in r) {
      if (r.missing) out.missing.push(minion)
      else out.errors.push({ minion, error: r.error })
      continue
    }
    out.minions.push({ id: minion, score: r.score, failed: checks.filter((c) => r.passed[c.id] === false).map((c) => c.id) })
    for (const c of out.checks) if (c.id in r.passed) (r.passed[c.id] ? c.pass : c.fail).push(minion)
  }
  out.minions.sort((a, b) => a.score - b.score || a.id.localeCompare(b.id))
  if (out.minions.length) out.score = Math.round(out.minions.reduce((s, m) => s + m.score, 0) / out.minions.length)
  return out
}

/** Evidence for an audit: one line per minion and check, with when and by which job it was checked. */
export function evidenceCsv(s: Summary, meta: { jid: string; at: string }) {
  const lines = [['minion', 'check', 'area', 'title', 'result', 'checked_at', 'jid'].join(',')]
  for (const m of s.minions) {
    for (const c of s.checks) {
      const result = c.pass.includes(m.id) ? 'pass' : c.fail.includes(m.id) ? 'fail' : 'unknown'
      lines.push([m.id, c.id, c.area, c.title, result, meta.at, meta.jid].map(csvCell).join(','))
    }
  }
  for (const id of s.missing) lines.push([id, '', '', '', 'no osquery', meta.at, meta.jid].map(csvCell).join(','))
  for (const e of s.errors) lines.push([e.minion, '', '', '', `error: ${e.error}`, meta.at, meta.jid].map(csvCell).join(','))
  return lines.join('\n') + '\n'
}
