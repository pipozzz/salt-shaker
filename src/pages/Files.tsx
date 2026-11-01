import clsx from 'clsx'
import { ChevronRight, Database, FileCode2, FileText, Folder, FolderOpen, Layers } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type { RootsKind } from '../api/salt'
import type { FileTree } from '../api/types'
import { CodeView } from '../components/CodeView'
import { JsonView } from '../components/JsonView'
import { Card, CardHeader, CopyButton, Empty, ErrorBox, PageHeader, Select, Spinner, Tabs } from '../components/ui'
import { useAsync } from '../lib/hooks'
import { useSalt } from '../lib/session'

type View = RootsKind | 'rendered'

export function FilesPage() {
  const [view, setView] = useState<View>('file')
  return (
    <>
      <PageHeader
        title="States & Pillar"
        description="Browse file_roots and pillar_roots on the master, or see the pillar a minion actually gets."
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
      {view === 'rendered' ? <RenderedPillar /> : <RootsBrowser key={view} kind={view} />}
    </>
  )
}

function RootsBrowser({ kind }: { kind: RootsKind }) {
  const salt = useSalt()
  const roots = useAsync(() => salt.roots(kind), [salt, kind])
  const envs = Object.keys(roots.data ?? {})
  const [env, setEnv] = useState('base')
  const [selected, setSelected] = useState<string | null>('top.sls')
  const file = useAsync(() => (selected ? salt.readFile(kind, selected, env) : Promise.resolve(null)), [salt, kind, selected, env])

  // merge every root dir of the env into one tree, like the fileserver does
  const tree = useMemo(() => {
    const merged: FileTree = {}
    for (const root of roots.data?.[env] ?? []) for (const t of Object.values(root)) Object.assign(merged, t)
    return merged
  }, [roots.data, env])
  const rootDirs = (roots.data?.[env] ?? []).flatMap((r) => Object.keys(r))

  return (
    <div className="grid gap-6 lg:grid-cols-[280px_1fr]">
      <Card className="h-fit">
        <CardHeader
          title={kind === 'file' ? 'file_roots' : 'pillar_roots'}
          subtitle={<span className="font-mono">{rootDirs.join(', ')}</span>}
          actions={
            envs.length > 1 && (
              <Select value={env} onChange={(e) => setEnv(e.target.value)} className="h-7 w-28 text-xs">
                {envs.map((e) => (
                  <option key={e}>{e}</option>
                ))}
              </Select>
            )
          }
        />
        <div className="max-h-[65vh] overflow-y-auto p-2">
          {roots.error && <ErrorBox error={roots.error} onRetry={roots.reload} />}
          {roots.loading && <Spinner />}
          {roots.data && Object.keys(tree).length === 0 && <Empty title="Empty root" />}
          <TreeNode tree={tree} path="" selected={selected} onSelect={setSelected} depth={0} />
        </div>
      </Card>

      <Card className="min-w-0">
        {selected ? (
          <>
            <CardHeader
              title={<span className="font-mono">{selected}</span>}
              subtitle={selected === 'top.sls' ? (kind === 'file' ? 'Maps states to minions' : 'Maps pillar data to minions') : `salt://${selected}`}
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
              <FileCode2 className={clsx('size-3.5 shrink-0', name.endsWith('.sls') ? 'text-accent-500' : 'text-zinc-400')} />
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
        <ChevronRight className={clsx('size-3.5 shrink-0 text-zinc-400 transition-transform', open && 'rotate-90')} />
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
  const [minion, setMinion] = useState('')
  useEffect(() => {
    if (!minion && keys.data?.minions[0]) setMinion([...keys.data.minions].sort()[0])
  }, [keys.data, minion])
  const pillar = useAsync(() => (minion ? salt.pillar(minion) : Promise.resolve(undefined)), [salt, minion])

  return (
    <Card>
      <CardHeader
        title="Compiled pillar"
        subtitle="What the minion sees after top.sls matching and rendering (pillar.show_pillar)."
        actions={
          <Select value={minion} onChange={(e) => setMinion(e.target.value)} className="w-48 font-mono">
            {[...(keys.data?.minions ?? [])].sort().map((m) => (
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
