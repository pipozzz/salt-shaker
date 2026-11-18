import { describe, expect, it } from 'vitest'
import { gitConfigUrl, gitPillarRemotes, headBranch, matchRemote, parseRemoteMap, repoLabel, treeFiles } from './gitpillar'

describe('gitPillarRemotes', () => {
  it('reads plain and parameterised remotes, skipping other ext_pillars', () => {
    const r = gitPillarRemotes([
      { cmd_yaml: 'cat /etc/x.yml' },
      {
        git: [
          'main https://github.com/acme/pillar.git',
          { 'dev git@github.com:acme/pillar.git': [{ root: '/pillar/' }, { env: 'base' }] },
          { '__env__ https://git.acme.io/pillar.git': [{ mountpoint: 'apps' }] },
        ],
      },
    ])
    expect(r).toEqual([
      { id: 'main https://github.com/acme/pillar.git', branch: 'main', url: 'https://github.com/acme/pillar.git' },
      { id: 'dev git@github.com:acme/pillar.git', branch: 'dev', url: 'git@github.com:acme/pillar.git', root: 'pillar', env: 'base', mountpoint: undefined },
      { id: '__env__ https://git.acme.io/pillar.git', branch: '__env__', url: 'https://git.acme.io/pillar.git', root: undefined, env: undefined, mountpoint: 'apps' },
    ])
  })

  it('is empty without git_pillar', () => {
    expect(gitPillarRemotes(null)).toEqual([])
    expect(gitPillarRemotes([{ cmd_json: 'x' }])).toEqual([])
  })
})

describe('git files', () => {
  it('parses remote_map.txt', () => {
    expect(parseRemoteMap('# git_pillar_remote map as of 18 Nov 2026 10:00:00.000\nabc123 = main https://github.com/acme/pillar.git\n')).toEqual({ abc123: 'main https://github.com/acme/pillar.git' })
  })

  it('reads the origin url and HEAD branch', () => {
    expect(gitConfigUrl('[core]\n\tbare = false\n[remote "origin"]\n\turl = https://github.com/acme/pillar.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n')).toBe('https://github.com/acme/pillar.git')
    expect(headBranch('ref: refs/heads/main\n')).toBe('main')
    expect(headBranch('9fceb02d0ae598e95dc970b74767f19372d61af8\n')).toBeUndefined()
  })
})

describe('matchRemote', () => {
  const remotes = gitPillarRemotes([{ git: ['main https://g/a.git', 'dev https://g/a.git', '__env__ https://g/b.git'] }])

  it('uses remote_map, with or without a branch subdirectory', () => {
    const map = { h1: 'dev https://g/a.git', h2: '__env__ https://g/b.git' }
    expect(matchRemote(remotes, { rel: 'h1' }, map)).toEqual({ remote: remotes[1], branch: 'dev' })
    expect(matchRemote(remotes, { rel: 'h2/feature' }, map)).toEqual({ remote: remotes[2], branch: 'feature' })
  })

  it('falls back to url and branch', () => {
    expect(matchRemote(remotes, { rel: 'x', url: 'https://g/a.git', head: 'main' }, {})).toEqual({ remote: remotes[0], branch: 'main' })
    // detached HEAD and two remotes on that url: can't tell
    expect(matchRemote(remotes, { rel: 'x', url: 'https://g/a.git' }, {})).toBeNull()
    expect(matchRemote(remotes, { rel: 'y', url: 'https://g/b.git' }, {})).toEqual({ remote: remotes[2], branch: '__env__' })
  })
})

describe('treeFiles', () => {
  it('lists files under root, without .git', () => {
    const dir = '/var/cache/salt/master/git_pillar/h1'
    const paths = [`${dir}/.git/HEAD`, `${dir}/README.md`, `${dir}/pillar/top.sls`, `${dir}/pillar/web/init.sls`]
    expect(treeFiles(paths, dir)).toEqual(['README.md', 'pillar/top.sls', 'pillar/web/init.sls'])
    expect(treeFiles(paths, `${dir}/`, 'pillar')).toEqual(['top.sls', 'web/init.sls'])
  })

  it('labels repos', () => {
    const [remote] = gitPillarRemotes([{ git: [{ 'main git@github.com:acme/pillar.git': [{ root: 'pillar' }] }] }])
    expect(repoLabel({ remote, dir: '/x', branch: 'main' })).toBe('main · acme/pillar/pillar')
  })
})
