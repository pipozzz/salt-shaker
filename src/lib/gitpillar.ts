/**
 * git_pillar: pillar from git repositories (an ext_pillar), which salt-api's pillar_roots can't see.
 * The master checks every configured remote out under <cachedir>/git_pillar, so the files are read
 * from there through salt.cmd on the master.
 */

/** One git_pillar remote as configured in the master's ext_pillar. */
export interface GitPillarRemote {
  /** The remote's id as Salt writes it, "<branch> <url>". */
  id: string
  branch: string
  url: string
  /** Subdirectory of the repo that holds the pillar (the remote's root parameter). */
  root?: string
  /** Pillar environment the remote maps to, when it isn't the branch. */
  env?: string
  mountpoint?: string
}

/** A checked out remote on the master. */
export interface GitPillarRepo {
  remote: GitPillarRemote
  /** Absolute path of the working tree on the master. */
  dir: string
  /** Branch actually checked out, for __env__ remotes that track every branch. */
  branch: string
}

function parseId(id: string): { branch: string; url: string } {
  const parts = id.trim().split(/\s+/)
  // the single-url form (no branch) is the long deprecated pre-2015 syntax; it tracks master
  return parts.length > 1 ? { branch: parts[0], url: parts.slice(1).join(' ') } : { branch: 'master', url: parts[0] }
}

function str(v: unknown) {
  return typeof v === 'string' && v ? v : undefined
}

/** git_pillar remotes from the master's ext_pillar option (a list of {name: config} dicts). */
export function gitPillarRemotes(extPillar: unknown): GitPillarRemote[] {
  if (!Array.isArray(extPillar)) return []
  const out: GitPillarRemote[] = []
  for (const entry of extPillar) {
    if (!entry || typeof entry !== 'object' || !('git' in entry)) continue
    const git = (entry as { git: unknown }).git
    const items = Array.isArray(git) ? git : [git]
    for (const item of items) {
      if (typeof item === 'string') {
        out.push({ id: item.trim(), ...parseId(item) })
      } else if (item && typeof item === 'object') {
        // {"<branch> <url>": [{root: ...}, {env: ...}]}
        for (const [id, params] of Object.entries(item)) {
          const p: Record<string, unknown> = Object.assign({}, ...(Array.isArray(params) ? params : [params]).filter((x) => x && typeof x === 'object'))
          out.push({ id: id.trim(), ...parseId(id), root: str(p.root)?.replace(/^\/+|\/+$/g, ''), env: str(p.env), mountpoint: str(p.mountpoint) })
        }
      }
    }
  }
  return out
}

/** remote_map.txt in the git_pillar cache: "<cache dir name> = <remote id>" per line. */
export function parseRemoteMap(text: string): Record<string, string> {
  const map: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*([^#=\s][^=]*?)\s*=\s*(.+?)\s*$/)
    if (m) map[m[1]] = m[2]
  }
  return map
}

/** The origin url from a .git/config. */
export function gitConfigUrl(text: string): string | undefined {
  let inOrigin = false
  for (const line of text.split('\n')) {
    const section = line.match(/^\s*\[(.+)\]\s*$/)
    if (section) inOrigin = /^remote\s+"origin"$/.test(section[1].trim())
    else if (inOrigin) {
      const m = line.match(/^\s*url\s*=\s*(.+?)\s*$/)
      if (m) return m[1]
    }
  }
  return undefined
}

/** The branch a .git/HEAD points at, or undefined when detached (GitPython checks out origin/<branch>). */
export function headBranch(text: string): string | undefined {
  return text.match(/^ref:\s*refs\/heads\/(.+?)\s*$/m)?.[1]
}

/**
 * Matches a working tree under the git_pillar cache to its configured remote. The cache dir is named
 * after a hash of the remote (and, on newer Salt, has a subdirectory per branch), which remote_map.txt
 * maps back to the remote id; without it the origin url and checked out branch are used.
 */
export function matchRemote(
  remotes: GitPillarRemote[],
  tree: { rel: string; url?: string; head?: string },
  remoteMap: Record<string, string>,
): { remote: GitPillarRemote; branch: string } | null {
  const [first, ...rest] = tree.rel.split('/')
  const mapped = remoteMap[tree.rel] ?? remoteMap[first]
  const fromMap = mapped ? remotes.find((r) => r.id === mapped.trim()) : undefined
  const remote =
    fromMap ??
    (tree.url
      ? (remotes.find((r) => r.url === tree.url && r.branch === tree.head) ?? (remotes.filter((r) => r.url === tree.url).length === 1 ? remotes.find((r) => r.url === tree.url) : undefined))
      : undefined)
  if (!remote) return null
  const branch = remote.branch === '__env__' ? (tree.head ?? (rest.length ? rest.join('/') : remote.branch)) : remote.branch
  return { remote, branch }
}

/** Paths under a working tree (relative to root inside it), without git's own files. */
export function treeFiles(paths: string[], dir: string, root?: string): string[] {
  const base = `${dir.replace(/\/+$/, '')}/${root ? `${root}/` : ''}`
  return paths
    .filter((p) => p.startsWith(base))
    .map((p) => p.slice(base.length))
    .filter((p) => p && !p.split('/').some((s) => s === '.git'))
    .sort()
}

/** Short label for a remote in a picker: branch and repo name. */
export function repoLabel(repo: GitPillarRepo) {
  const name = repo.remote.url.replace(/\.git$/, '').split(/[/:]/).filter(Boolean).slice(-2).join('/')
  return `${repo.branch} · ${name}${repo.remote.root ? `/${repo.remote.root}` : ''}`
}
