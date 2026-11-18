import clsx from 'clsx'
import { ChevronRight, Database, FileCode2, FileText, Folder, FolderOpen, GitBranch, Layers, RefreshCw } from 'lucide-react'
import { type ReactNode, useMemo, useState } from 'react'
import type { RootsKind } from '../api/salt'
import type { FileTree } from '../api/types'
import { CodeView } from '../components/CodeView'
import { JsonView } from '../components/JsonView'
import { Button, Card, CardHeader, CopyButton, Empty, ErrorBox, PageHeader, Select, Spinner, Tabs } from '../components/ui'
import { useAsync } from '../lib/hooks'
import { buildTree } from '../lib/filetree'
import { repoLabel, type GitPillarRepo } from '../lib/gitpillar'
import { useCan, useSalt } from '../lib/session'

type View = RootsKind | 'rendered'

export function FilesPage() {
  const [view, setView] = useState<View>('file')
  return (
    <>
      <PageHeader
        title="States & Pillar"
        description="Browse the states the master serves (file_roots and gitfs, per branch) and pillar files (pillar_roots and git_pillar), or see the pillar a minion actually gets."
        actions={
          <Tabs
            value={view}
            onChange={setView}
            items={[
              { value: 'file', label: <><Layers className="size-4" /> States</> },
              { value: 'pillar', label: <><Database className="size-4" /> Pillar files</> },
              { value: 'rendered', label: 'Pillar by minion' },
            ]}
          />
        }
      />
      {view === 'rendered' ? <RenderedPillar /> : view === 'file' ? <StatesBrowser /> : <PillarFiles />}
    </>
  )
}

/** States from the fileserver when the user may list it (so gitfs shows up too), else file_roots on disk. */
function StatesBrowser() {
  const can = useCan()
  return can('runner', 'fileserver.file_list') && can('runner', 'salt.cmd') ? <ServedBrowser /> : <RootsBrowser kind="file" />
}

/** What minions get: every fileserver backend (file_roots, gitfs, …) merged, per saltenv. */
function ServedBrowser() {
  const salt = useSalt()
  const can = useCan()
  const envs = useAsync(() => salt.saltenvs(), [salt])
  const [env, setEnv] = useState('base')
  const list = useAsync(() => salt.served(env), [salt, env])
  const tree = useMemo(() => buildTree(list.data ?? []), [list.data])
  const [updating, setUpdating] = useState(false)
  const [updateError, setUpdateError] = useState<Error | null>(null)
  const update = async () => {
    setUpdating(true)
    setUpdateError(null)
    try {
      await salt.updateFileserver()
      envs.reload()
      list.reload()
    } catch (e) {
      setUpdateError(e instanceof Error ? e : new Error(String(e)))
    } finally {
      setUpdating(false)
    }
  }
  const branches = envs.data ?? ['base']
  return (
    <Browser
      title="Fileserver"
      subtitle={branches.length > 1 ? `${branches.length} environments, from file_roots and gitfs` : 'file_roots and gitfs, as minions get them'}
      envs={branches}
      env={env}
      onEnv={setEnv}
      tree={tree}
      loading={list.loading}
      error={list.error || updateError}
      onRetry={list.reload}
      read={(path) => salt.readServed(path, env)}
      topHint="Maps states to minions"
      extra={
        can('runner', 'fileserver.update') && (
          <Button size="sm" icon={<RefreshCw className="size-3.5" />} loading={updating} onClick={update} title="Fetch gitfs remotes now (fileserver.update) instead of at the next update interval">
            Update
          </Button>
        )
      }
      empty={
        <Empty title="Nothing served">
          The fileserver serves no files{env === 'base' ? '' : ` in ${env}`}. Check <span className="font-mono">fileserver_backend</span>, and for gitfs the master's log.
        </Empty>
      }
    />
  )
}

/**
 * Pillar files: pillar_roots on disk, and with git_pillar the repos the master checked out. The
 * picker switches between them when there's more than one source.
 */
function PillarFiles() {
  const salt = useSalt()
  const can = useCan()
  const canGit = can('runner', 'salt.cmd')
  const remotes = useAsync(() => (canGit ? salt.gitPillarRemotes().catch(() => []) : Promise.resolve([])), [salt, canGit])
  const hasGit = (remotes.data?.length ?? 0) > 0
  const repos = useAsync(() => (hasGit ? salt.gitPillarRepos(remotes.data ?? []) : Promise.resolve([])), [salt, hasGit, remotes.data])
  const roots = useAsync(() => salt.roots('pillar'), [salt])
  const rootsHaveFiles = Object.values(roots.data ?? {}).some((rs) => rs.some((r) => Object.values(r).some((t) => Object.keys(t).length > 0)))
  const [source, setSource] = useState<string | null>(null)
  const [updating, setUpdating] = useState(false)
  const [updateError, setUpdateError] = useState<Error | null>(null)

  if (remotes.loading) return <Spinner />
  if (!hasGit) return <RootsBrowser kind="pillar" />

  const list = repos.data ?? []
  const sources = [...list.map((r) => r.dir), ...(rootsHaveFiles ? ['pillar_roots'] : [])]
  const current = source && sources.includes(source) ? source : (sources[0] ?? null)
  const picker = sources.length > 1 && (
    <Select value={current ?? ''} onChange={(e) => setSource(e.target.value)} className="h-7 w-44 text-xs" aria-label="Pillar source">
      {list.map((r) => (
        <option key={r.dir} value={r.dir}>
          {repoLabel(r)}
        </option>
      ))}
      {rootsHaveFiles && <option value="pillar_roots">pillar_roots</option>}
    </Select>
  )
  const update = async () => {
    setUpdating(true)
    setUpdateError(null)
    try {
      await salt.updateGitPillar()
      repos.reload()
    } catch (e) {
      setUpdateError(e instanceof Error ? e : new Error(String(e)))
    } finally {
      setUpdating(false)
    }
  }
  const updateButton = can('runner', 'git_pillar.update') && (
    <Button size="sm" icon={<RefreshCw className="size-3.5" />} loading={updating} onClick={update} title="Fetch the git_pillar remotes now (git_pillar.update)">
      Update
    </Button>
  )

  if (current === 'pillar_roots') return <RootsBrowser kind="pillar" extra={picker} />
  const repo = list.find((r) => r.dir === current)
  if (repo) return <GitPillarBrowser key={repo.dir} repo={repo} extra={<>{updateButton}{picker}</>} error={updateError} />

  return (
    <Card>
      <CardHeader title="git_pillar" subtitle={<span className="font-mono">{remotes.data!.map((r) => r.id).join(', ')}</span>} actions={updateButton} />
      <div className="p-2">
        {(repos.error || updateError) && <ErrorBox error={(repos.error || updateError)!} onRetry={repos.reload} />}
        {repos.loading ? (
          <Spinner />
        ) : (
          !repos.error && (
            <Empty icon={<GitBranch />} title="Not checked out yet">
              Pillar comes from git_pillar, but the master has no checkout of it under <span className="font-mono">cachedir/git_pillar</span>. It fetches the remotes when it first compiles pillar; Update fetches them now. If this stays empty, check the master's log for git_pillar errors.
            </Empty>
          )
        )}
      </div>
    </Card>
  )
}

function GitPillarBrowser({ repo, extra, error }: { repo: GitPillarRepo; extra: ReactNode; error: Error | null }) {
  const salt = useSalt()
  const files = useAsync(() => salt.gitPillarFiles(repo), [salt, repo])
  const tree = useMemo(() => buildTree(files.data ?? []), [files.data])
  const { remote } = repo
  return (
    <Browser
      title={
        <span className="flex items-center gap-1.5">
          <GitBranch className="size-4 text-zinc-500 dark:text-zinc-400" /> git_pillar
        </span>
      }
      subtitle={
        <span className="font-mono" title={remote.id}>
          {repo.branch} {remote.url}
          {remote.root ? ` (root: ${remote.root})` : ''}
          {remote.mountpoint ? ` → ${remote.mountpoint}` : ''}
        </span>
      }
      envs={[]}
      env={repo.dir}
      onEnv={() => {}}
      tree={tree}
      loading={files.loading}
      error={files.error || error}
      onRetry={files.reload}
      read={(path) => salt.readGitPillar(repo, path)}
      topHint={remote.env ? `Maps pillar data to minions (pillar env ${remote.env})` : 'Maps pillar data to minions'}
      fileHint={(path) => `${remote.root ? `${remote.root}/` : ''}${path} on ${repo.branch}`}
      extra={extra}
      empty={
        <Empty title="No files">
          The checkout of {repo.branch} has no files{remote.root ? ` under ${remote.root}` : ''}.
        </Empty>
      }
    />
  )
}

function RootsBrowser({ kind, extra }: { kind: RootsKind; extra?: ReactNode }) {
  const salt = useSalt()
  const roots = useAsync(() => salt.roots(kind), [salt, kind])
  const [env, setEnv] = useState('base')

  // merge every root dir of the env into one tree, like the fileserver does
  const tree = useMemo(() => {
    const merged: FileTree = {}
    for (const root of roots.data?.[env] ?? []) for (const t of Object.values(root)) Object.assign(merged, t)
    return merged
  }, [roots.data, env])
  const rootDirs = (roots.data?.[env] ?? []).flatMap((r) => Object.keys(r))

  return (
    <Browser
      title={kind === 'file' ? 'file_roots' : 'pillar_roots'}
      subtitle={<span className="font-mono">{rootDirs.join(', ')}</span>}
      envs={Object.keys(roots.data ?? {})}
      env={env}
      onEnv={setEnv}
      tree={tree}
      loading={roots.loading}
      error={roots.error}
      onRetry={roots.reload}
      read={(path) => salt.readFile(kind, path, env)}
      topHint={kind === 'pillar' ? 'Maps pillar data to minions' : 'Maps states to minions'}
      extra={extra}
      empty={
        <Empty title="Empty root">
          {kind === 'pillar'
            ? 'With git_pillar or another ext_pillar, pillar files live in their repository and salt-api can\'t read them. Pillar by minion shows what each minion gets.'
            : null}
        </Empty>
      }
    />
  )
}

function Browser({
  title,
  subtitle,
  envs,
  env,
  onEnv,
  tree,
  loading,
  error,
  onRetry,
  read,
  topHint,
  fileHint,
  extra,
  empty,
}: {
  title: ReactNode
  subtitle: ReactNode
  envs: string[]
  env: string
  onEnv: (env: string) => void
  tree: FileTree
  loading: boolean
  error: Error | null
  onRetry: () => void
  read: (path: string) => Promise<string>
  topHint: string
  /** Subtitle for any other file; salt://path by default. */
  fileHint?: (path: string) => string
  extra?: ReactNode
  empty: ReactNode
}) {
  const [picked, setPicked] = useState<string | null>(null)
  // open top.sls by default, but only when there is one: an empty root has nothing to show
  const selected = picked ?? (tree['top.sls'] === 'f' ? 'top.sls' : null)
  const setSelected = setPicked
  const file = useAsync(() => (selected ? read(selected) : Promise.resolve(null)), [selected, env, title])
  const isEmpty = !loading && !error && Object.keys(tree).length === 0

  return (
    <div className="grid gap-6 lg:grid-cols-[300px_1fr]">
      <Card className="h-fit">
        <CardHeader
          title={title}
          subtitle={subtitle}
          actions={
            <div className="flex items-center gap-2">
              {extra}
              {envs.length > 1 && (
                <Select value={env} onChange={(e) => onEnv(e.target.value)} className="h-7 w-36 text-xs" aria-label="Environment">
                  {envs.map((e) => (
                    <option key={e}>{e}</option>
                  ))}
                </Select>
              )}
            </div>
          }
        />
        <div className="max-h-[65vh] overflow-y-auto p-2">
          {error && <ErrorBox error={error} onRetry={onRetry} />}
          {loading && <Spinner />}
          {isEmpty && empty}
          {!loading && <TreeNode tree={tree} path="" selected={selected} onSelect={setSelected} depth={0} />}
        </div>
      </Card>

      <Card className="min-w-0">
        {selected ? (
          <>
            <CardHeader
              title={<span className="font-mono">{selected}</span>}
              subtitle={selected === 'top.sls' ? topHint : (fileHint?.(selected) ?? `salt://${selected}${env === 'base' ? '' : ` (${env})`}`)}
              actions={file.data && <CopyButton text={file.data} />}
            />
            <div className="py-2">
              {file.error && (
                <div className="p-3">
                  <ErrorBox error={file.error} />
                </div>
              )}
              {file.loading && <Spinner />}
              {!file.loading && file.data !== null && file.data !== undefined && <CodeView code={file.data} />}
            </div>
          </>
        ) : (
          <Empty icon={<FileText />} title="Select a file" />
        )}
      </Card>
    </div>
  )
}

function TreeNode({ tree, path, selected, onSelect, depth }: { tree: FileTree; path: string; selected: string | null; onSelect: (p: string) => void; depth: number }) {
  const entries = Object.entries(tree).sort(([a, av], [b, bv]) => Number(typeof av === 'string') - Number(typeof bv === 'string') || a.localeCompare(b))
  return (
    <ul>
      {entries.map(([name, node]) =>
        typeof node === 'string' ? (
          <li key={name}>
            <button
              onClick={() => onSelect(path + name)}
              style={{ paddingLeft: depth * 14 + 26 }}
              className={clsx(
                'flex w-full items-center gap-1.5 rounded-md py-1 pr-2 text-left text-sm',
                selected === path + name ? 'bg-accent-50 font-medium text-accent-700 dark:bg-accent-700/20 dark:text-accent-400' : 'text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800/60',
              )}
            >
              <FileCode2 className={clsx('size-3.5 shrink-0', name.endsWith('.sls') ? 'text-accent-500' : 'text-zinc-500 dark:text-zinc-400')} />
              <span className="truncate">{name}</span>
            </button>
          </li>
        ) : (
          <Dir key={name} name={name} node={node} path={`${path}${name}/`} selected={selected} onSelect={onSelect} depth={depth} />
        ),
      )}
    </ul>
  )
}

function Dir({ name, node, path, selected, onSelect, depth }: { name: string; node: FileTree; path: string; selected: string | null; onSelect: (p: string) => void; depth: number }) {
  const [open, setOpen] = useState(depth < 1 || !!selected?.startsWith(path))
  const Icon = open ? FolderOpen : Folder
  return (
    <li>
      <button onClick={() => setOpen(!open)} style={{ paddingLeft: depth * 14 + 6 }} className="flex w-full items-center gap-1 rounded-md py-1 pr-2 text-left text-sm text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800/60">
        <ChevronRight className={clsx('size-3.5 shrink-0 text-zinc-500 transition-transform dark:text-zinc-400', open && 'rotate-90')} />
        <Icon className="size-3.5 shrink-0 text-amber-500" />
        <span className="truncate">{name}</span>
      </button>
      {open && <TreeNode tree={node} path={path} selected={selected} onSelect={onSelect} depth={depth + 1} />}
    </li>
  )
}

function RenderedPillar() {
  const salt = useSalt()
  const keys = useAsync(() => salt.keys(), [salt])
  const [picked, setMinion] = useState('')
  const sorted = useMemo(() => [...(keys.data?.minions ?? [])].sort(), [keys.data])
  // until someone picks one, show the first minion
  const minion = picked || sorted[0] || ''
  const pillar = useAsync(() => (minion ? salt.pillar(minion) : Promise.resolve(undefined)), [salt, minion])

  return (
    <Card>
      <CardHeader
        title="Compiled pillar"
        subtitle="What the minion sees after top.sls matching and rendering (pillar.show_pillar)."
        actions={
          <Select value={minion} onChange={(e) => setMinion(e.target.value)} className="w-48 font-mono">
            {sorted.map((m) => (
              <option key={m}>{m}</option>
            ))}
          </Select>
        }
      />
      <div className="p-4 pl-8">
        {(keys.error || pillar.error) && <ErrorBox error={(keys.error || pillar.error)!} onRetry={pillar.reload} />}
        {pillar.loading && <Spinner label="Rendering pillar…" />}
        {pillar.data && !pillar.loading && <JsonView value={pillar.data} openDepth={4} />}
      </div>
    </Card>
  )
}
