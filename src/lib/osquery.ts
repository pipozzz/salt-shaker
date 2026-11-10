/*
 * osquery on minions: the script that installs it from the official osquery repositories, how a
 * query runs (osqueryi reads it on stdin, so no shell quoting), and how its output is read back.
 */

/** Marks the install jobs, so they're recognisable in the job history. */
export const OSQUERY_INSTALL_MARKER = 'salt-shaker:osquery-install'

/**
 * Adds the osquery repository (pkg.osquery.io, signed with its own key) and installs osquery with
 * apt or dnf/yum. Prints the version on success; other systems get a clear error.
 */
export const OSQUERY_INSTALL_SCRIPT = [
  `# ${OSQUERY_INSTALL_MARKER} v1`,
  'set -e',
  'if command -v osqueryi >/dev/null 2>&1; then osqueryi --version; exit 0; fi',
  'fetch() { if command -v curl >/dev/null 2>&1; then curl -fsSL "$1"; else wget -qO- "$1"; fi; }',
  'if command -v apt-get >/dev/null 2>&1; then',
  '  export DEBIAN_FRONTEND=noninteractive',
  '  mkdir -p /etc/apt/keyrings',
  '  fetch https://pkg.osquery.io/deb/pubkey.gpg > /etc/apt/keyrings/osquery.asc',
  '  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/osquery.asc] https://pkg.osquery.io/deb deb main" > /etc/apt/sources.list.d/osquery.list',
  '  apt-get update -qq -o Dir::Etc::sourcelist=sources.list.d/osquery.list -o Dir::Etc::sourceparts=- -o APT::Get::List-Cleanup=0',
  '  apt-get install -y -qq osquery >/dev/null',
  'elif command -v dnf >/dev/null 2>&1 || command -v yum >/dev/null 2>&1; then',
  '  fetch https://pkg.osquery.io/rpm/GPG > /etc/pki/rpm-gpg/RPM-GPG-KEY-osquery',
  '  fetch https://pkg.osquery.io/rpm/osquery-s3-rpm.repo > /etc/yum.repos.d/osquery-s3-rpm.repo',
  '  if command -v dnf >/dev/null 2>&1; then dnf install -y -q osquery; else yum install -y -q osquery; fi',
  'else',
  '  echo "osquery packages exist for apt and dnf/yum systems only" >&2; exit 1',
  'fi',
  'osqueryi --version',
  '',
].join('\n')

export const OSQUERY_INSTALL_KWARG = { python_shell: true, shell: '/bin/sh', timeout: 600 }

/** The cmd.run call for a query: osqueryi reads the SQL on stdin and prints JSON. */
export const osqueryCall = (sql: string) => ({
  arg: ['osqueryi --json'],
  kwarg: { stdin: sql.trim().replace(/;?\s*$/, ';'), python_shell: false, timeout: 120 },
})

/** Only one read-only statement: SELECT, or WITH … SELECT. */
export function checkQuery(sql: string): string | null {
  const s = stripComments(sql).trim().replace(/;\s*$/, '')
  if (!s) return 'Write a query'
  if (!/^(select|with)\b/i.test(s)) return 'Only SELECT queries can run here'
  if (s.includes(';')) return 'One query at a time'
  return null
}

function stripComments(sql: string) {
  return sql.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
}

export type OsqueryRow = Record<string, string>
export type OsqueryResult = { rows: OsqueryRow[] } | { error: string; missing?: boolean }

/** Reads one minion's cmd.run return: a JSON array of rows, or why there isn't one. */
export function parseOsquery(ret: unknown): OsqueryResult {
  if (Array.isArray(ret)) return { rows: ret as OsqueryRow[] }
  if (typeof ret !== 'string') return { error: ret === false ? 'The minion did not run the query' : 'Unexpected return' }
  const text = ret.trim()
  if (/osqueryi.*(not found|No such file)|command not found/i.test(text)) return { error: 'osquery is not installed', missing: true }
  // warnings (e.g. about the database lock) can come before the JSON
  const start = text.search(/^\[/m)
  if (start >= 0) {
    try {
      const rows = JSON.parse(text.slice(start)) as unknown
      if (Array.isArray(rows)) return { rows: rows.map((r) => Object.fromEntries(Object.entries(r as Record<string, unknown>).map(([k, v]) => [k, v == null ? '' : String(v)]))) }
    } catch {
      // not JSON after all; fall through to the error
    }
  }
  if (!text) return { rows: [] }
  return { error: text.split('\n').find((l) => /error/i.test(l))?.trim() || text.split('\n')[0].slice(0, 300) }
}

export interface LibraryQuery {
  name: string
  description: string
  sql: string
}

/** Ready-made queries for the usual questions. */
export const OSQUERY_LIBRARY: LibraryQuery[] = [
  {
    name: 'Listening ports',
    description: 'Processes accepting connections, and on which address',
    sql: "SELECT DISTINCT p.name, l.port, l.protocol, l.address, p.path\nFROM listening_ports l JOIN processes p USING (pid)\nWHERE l.port != 0\nORDER BY l.port;",
  },
  {
    name: 'Logged-in users',
    description: 'Who is logged in right now, from where',
    sql: 'SELECT user, tty, host, datetime(time, \'unixepoch\') AS since\nFROM logged_in_users\nWHERE type = \'user\';',
  },
  {
    name: 'Users with a login shell',
    description: 'Local accounts that can log in',
    sql: "SELECT username, uid, gid, directory, shell\nFROM users\nWHERE shell NOT LIKE '%nologin' AND shell NOT LIKE '%false'\nORDER BY uid;",
  },
  {
    name: 'Authorized SSH keys',
    description: 'Keys that let someone log in, per account',
    sql: 'SELECT u.username, k.key_file, k.algorithm, substr(k.key, -24) AS key_end\nFROM users u CROSS JOIN authorized_keys k USING (uid);',
  },
  {
    name: 'SUID binaries',
    description: 'Programs that run with their owner\'s rights',
    sql: "SELECT path, username, permissions\nFROM suid_bin\nORDER BY path;",
  },
  {
    name: 'Cron jobs',
    description: 'Scheduled commands from crontabs',
    sql: 'SELECT event, minute, hour, day_of_month, month, day_of_week, command, path\nFROM crontab;',
  },
  {
    name: 'Kernel modules',
    description: 'Loaded kernel modules',
    sql: 'SELECT name, size, used_by, status\nFROM kernel_modules\nORDER BY name;',
  },
  {
    name: 'Top processes by memory',
    description: 'The ten processes using the most memory',
    sql: 'SELECT pid, name, uid, resident_size / 1048576 AS rss_mb, cmdline\nFROM processes\nORDER BY resident_size DESC\nLIMIT 10;',
  },
  {
    name: 'OS and uptime',
    description: 'Distribution, kernel and how long since boot',
    sql: 'SELECT o.name, o.version, k.version AS kernel, u.days AS uptime_days\nFROM os_version o, kernel_info k, uptime u;',
  },
]

export interface RowGroup {
  row: OsqueryRow
  minions: string[]
}

/**
 * Rows that are the same apart from the minion, once each with the minions that have them, rarest
 * first: what only a few minions have (an extra account, an odd port) is what usually matters.
 */
export function groupRows(rows: Array<OsqueryRow & { minion: string }>): RowGroup[] {
  const groups = new Map<string, RowGroup>()
  for (const { minion, ...row } of rows) {
    const key = JSON.stringify(Object.entries(row).sort(([a], [b]) => a.localeCompare(b)))
    const g = groups.get(key) ?? { row, minions: [] }
    if (!g.minions.includes(minion)) g.minions.push(minion)
    groups.set(key, g)
  }
  return [...groups.values()].sort((a, b) => a.minions.length - b.minions.length || Object.values(a.row).join('\t').localeCompare(Object.values(b.row).join('\t')))
}
