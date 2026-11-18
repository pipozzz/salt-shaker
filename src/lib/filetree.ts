import type { FileTree } from '../api/types'

/** A nested tree (directories as objects, files as 'f') from slash-separated paths. */
export function buildTree(paths: string[]): FileTree {
  const root: FileTree = {}
  for (const p of paths) {
    const parts = p.split('/')
    let node = root
    parts.forEach((part, i) => {
      if (i === parts.length - 1) node[part] = 'f'
      else node = (node[part] ??= {}) as FileTree
    })
  }
  return root
}
