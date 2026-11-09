/** Marks the jobs that collect package inventories, so the server finds their returns. */
export const INVENTORY_MARKER = 'salt-shaker:inventory'

/**
 * A POSIX shell script that prints the minion's OS (from /etc/os-release) and its installed
 * packages, one per line, tab separated:
 *
 *   os   <ID> <VERSION_ID> <VERSION>
 *   pkg  <name> <version> <binary package>
 *
 * Debian, Ubuntu and Alpine list the source package (what their security trackers are keyed on);
 * RPM systems list the package itself, with its epoch when it has one.
 */
export const INVENTORY_SCRIPT = [
  `# ${INVENTORY_MARKER} v1 (installed packages, for the vulnerability check)`,
  'if [ -r /etc/os-release ]; then . /etc/os-release; fi',
  "printf 'os\\t%s\\t%s\\t%s\\n' \"$ID\" \"$VERSION_ID\" \"$VERSION\"",
  'if command -v dpkg-query >/dev/null 2>&1; then',
  "  dpkg-query -W -f '${db:Status-Abbrev}\\t${source:Package}\\t${source:Version}\\t${Package}\\n' 2>/dev/null | awk -F '\\t' '$1 ~ /^ii/ { print \"pkg\\t\" $2 \"\\t\" $3 \"\\t\" $4 }'",
  'elif command -v rpm >/dev/null 2>&1; then',
  "  rpm -qa --qf 'pkg\\t%{NAME}\\t%|EPOCH?{%{EPOCH}:}:{}|%{VERSION}-%{RELEASE}\\t%{NAME}\\n' 2>/dev/null",
  'elif command -v apk >/dev/null 2>&1; then',
  '  apk list -I 2>/dev/null | awk \'{ n = split($1, p, "-"); b = p[1]; for (i = 2; i <= n - 2; i++) b = b "-" p[i]; o = $3; gsub(/[{}]/, "", o); print "pkg\\t" o "\\t" p[n-1] "-" p[n] "\\t" b }\'',
  'fi',
  '',
].join('\n')

/** The cmd.run keyword arguments the script needs. */
export const INVENTORY_KWARG = { python_shell: true, shell: '/bin/sh' }
