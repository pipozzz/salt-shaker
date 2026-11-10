import { OSQUERY_INSTALL_MARKER } from '../lib/osquery'

/*
 * What osqueryi answers in the demo: made-up rows for the tables the library queries read, shaped
 * like the real thing (strings, as `osqueryi --json` prints them). worker-01 starts without osquery,
 * so the install flow can be tried.
 */

const installed = new Set(['web-01', 'web-02', 'db-01', 'cache-01', 'mon-01'])

type Row = Record<string, string>

function tables(id: string, os: string, release: string): Record<string, Row[]> {
  const web = id.startsWith('web')
  const db = id.startsWith('db')
  const ports: Row[] = [
    { name: 'sshd', port: '22', protocol: '6', address: '0.0.0.0', pid: '812', path: '/usr/sbin/sshd' },
    { name: 'salt-minion', port: '0', protocol: '6', address: '0.0.0.0', pid: '901', path: '/usr/bin/python3' },
    ...(web
      ? [
          { name: 'nginx', port: '80', protocol: '6', address: '0.0.0.0', pid: '1204', path: '/usr/sbin/nginx' },
          { name: 'nginx', port: '443', protocol: '6', address: '0.0.0.0', pid: '1204', path: '/usr/sbin/nginx' },
        ]
      : []),
    ...(db ? [{ name: 'postgres', port: '5432', protocol: '6', address: '10.0.2.21', pid: '1530', path: '/usr/lib/postgresql/15/bin/postgres' }] : []),
    ...(id === 'web-02' ? [{ name: 'python3', port: '8000', protocol: '6', address: '0.0.0.0', pid: '4411', path: '/usr/bin/python3' }] : []),
    ...(id === 'mon-01' ? [{ name: 'prometheus', port: '9090', protocol: '6', address: '0.0.0.0', pid: '2210', path: '/usr/bin/prometheus' }] : []),
  ]
  return {
    listening_ports: ports.filter((p) => p.port !== '0'),
    logged_in_users: id === 'web-01' ? [{ user: 'pam', tty: 'pts/0', host: '10.0.9.4', since: '2026-11-10 07:42:10' }] : [],
    users: [
      { username: 'root', uid: '0', gid: '0', directory: '/root', shell: '/bin/bash' },
      { username: 'deploy', uid: '1000', gid: '1000', directory: '/home/deploy', shell: '/bin/bash' },
      ...(id === 'web-02' ? [{ username: 'tmpadmin', uid: '1001', gid: '1001', directory: '/home/tmpadmin', shell: '/bin/bash' }] : []),
    ],
    authorized_keys: [
      { username: 'deploy', key_file: '/home/deploy/.ssh/authorized_keys', algorithm: 'ssh-ed25519', key_end: 'q3L8vN2pXw7RkT0mYc1Z' },
      ...(id === 'web-02' ? [{ username: 'tmpadmin', key_file: '/home/tmpadmin/.ssh/authorized_keys', algorithm: 'ssh-rsa', key_end: 'Hh4kP9sW2xQe7uJ0aB5n' }] : []),
    ],
    suid_bin: ['/usr/bin/chfn', '/usr/bin/gpasswd', '/usr/bin/mount', '/usr/bin/passwd', '/usr/bin/su', '/usr/bin/sudo', '/usr/bin/umount', ...(id === 'db-01' ? ['/tmp/.cache/bash'] : [])].map((path) => ({ path, username: 'root', permissions: 'S' })),
    crontab: [
      { event: '', minute: '17', hour: '*', day_of_month: '*', month: '*', day_of_week: '*', command: 'cd / && run-parts --report /etc/cron.hourly', path: '/etc/crontab' },
      ...(db ? [{ event: '', minute: '0', hour: '2', day_of_month: '*', month: '*', day_of_week: '*', command: '/usr/local/bin/pg-backup.sh', path: '/var/spool/cron/crontabs/postgres' }] : []),
    ],
    kernel_modules: ['br_netfilter', 'ip_tables', 'nf_conntrack', 'overlay', 'x_tables', ...(id === 'mon-01' ? ['xfs'] : ['ext4'])].map((name, i) => ({ name, size: String(16384 * (i + 2)), used_by: '-', status: 'Live' })),
    processes: [
      { pid: web ? '1204' : db ? '1530' : '901', name: web ? 'nginx' : db ? 'postgres' : 'salt-minion', uid: web ? '33' : db ? '106' : '0', rss_mb: web ? '214' : db ? '1630' : '96', cmdline: web ? 'nginx: worker process' : db ? 'postgres: checkpointer' : '/usr/bin/salt-minion' },
      { pid: '901', name: 'salt-minion', uid: '0', rss_mb: '96', cmdline: '/usr/bin/salt-minion' },
      { pid: '812', name: 'sshd', uid: '0', rss_mb: '9', cmdline: 'sshd: /usr/sbin/sshd -D' },
    ],
    os_version: [{ name: os === 'Rocky' ? 'Rocky Linux' : os, version: release, kernel: os === 'Rocky' ? '5.14.0-503.11.1.el9_5.x86_64' : '6.8.0-48-generic', uptime_days: String(10 + id.length) }],
  }
}

const PRIORITY = ['authorized_keys', 'listening_ports', 'logged_in_users', 'suid_bin', 'crontab', 'kernel_modules', 'os_version', 'users', 'processes']

/** The demo's answer to `osqueryi --json` (the SQL comes on stdin), as cmd.run would return it. */
export function demoOsquery(id: string, os: string, release: string, cmd: string, stdin: string): string {
  if (cmd.includes(OSQUERY_INSTALL_MARKER)) {
    installed.add(id)
    return 'osqueryi version 5.24.1'
  }
  if (!installed.has(id)) return `ERROR: Unable to run command '['osqueryi', '--json']', reason: [Errno 2] No such file or directory: 'osqueryi'`
  const t = tables(id, os, release)
  // the most specific table the query mentions decides the rows; anything else isn't in the demo
  const from = PRIORITY.find((name) => new RegExp(`\\b${name}\\b`, 'i').test(stdin))
  if (!from) return `Error: no such table: ${/\bfrom\s+([a-z_]+)/i.exec(stdin)?.[1] ?? '?'} (the demo answers the library queries)`
  let rows = t[from]
  const limit = /\blimit\s+(\d+)/i.exec(stdin)
  if (limit) rows = rows.slice(0, Number(limit[1]))
  return JSON.stringify(rows, null, 2)
}
