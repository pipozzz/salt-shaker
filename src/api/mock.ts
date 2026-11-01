import { SaltError, type FileTree, type Grains, type JobSummary, type KeyList, type Lowstate, type SaltEvent, type Session, type Transport } from './types'

/**
 * An in-browser fake Salt master for demo mode. It answers the same lowstate calls
 * as salt-api so every page runs through the real code path.
 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const rand = (min: number, max: number) => Math.floor(Math.random() * (max - min + 1)) + min

interface MockMinion {
  grains: Grains
  up: boolean
}

function makeGrains(id: string, os: string, osrelease: string, cpus: number, mem: number, ip: string, roles: string[]): Grains {
  const osfinger = `${os}-${osrelease.split('.')[0]}`
  return {
    id,
    host: id,
    fqdn: `${id}.lab.internal`,
    os,
    os_family: os === 'Rocky' ? 'RedHat' : 'Debian',
    osrelease,
    osfinger,
    kernel: 'Linux',
    kernelrelease: os === 'Rocky' ? '5.14.0-503.el9.x86_64' : '6.8.0-48-generic',
    cpuarch: 'x86_64',
    cpu_model: 'AMD EPYC 7763 64-Core Processor',
    num_cpus: cpus,
    mem_total: mem,
    ipv4: ['127.0.0.1', ip],
    saltversion: '3007.1',
    pythonversion: [3, 10, 14, 'final', 0],
    virtual: 'kvm',
    roles,
    environment: 'lab',
  }
}

const minions: Record<string, MockMinion> = {
  'web-01': { up: true, grains: makeGrains('web-01', 'Ubuntu', '24.04', 4, 7951, '10.0.1.11', ['web', 'nginx']) },
  'web-02': { up: true, grains: makeGrains('web-02', 'Ubuntu', '24.04', 4, 7951, '10.0.1.12', ['web', 'nginx']) },
  'db-01': { up: true, grains: makeGrains('db-01', 'Debian', '12', 8, 32093, '10.0.2.21', ['db', 'postgres']) },
  'cache-01': { up: false, grains: makeGrains('cache-01', 'Debian', '12', 2, 3934, '10.0.2.31', ['cache', 'redis']) },
  'mon-01': { up: true, grains: makeGrains('mon-01', 'Rocky', '9.4', 2, 3934, '10.0.3.41', ['monitoring']) },
  'worker-01': { up: true, grains: makeGrains('worker-01', 'Ubuntu', '22.04', 16, 64220, '10.0.4.51', ['worker']) },
}

const keys: KeyList = {
  minions: Object.keys(minions),
  minions_pre: ['worker-02', 'edge-lon-01'],
  minions_rejected: ['laptop-guest'],
  minions_denied: [],
}

const files: Record<'file' | 'pillar', Record<string, string>> = {
  file: {
    'top.sls': `base:\n  '*':\n    - common\n    - users\n  'roles:web':\n    - match: grain\n    - webserver\n  'db-*':\n    - postgres\n`,
    'common/init.sls': `# Baseline applied to every minion\nmotd:\n  file.managed:\n    - name: /etc/motd\n    - contents: |\n        Managed by Salt — {{ grains['id'] }}\n\nbase-tools:\n  pkg.installed:\n    - pkgs:\n      - vim\n      - htop\n      - curl\n\ntimezone:\n  timezone.system:\n    - name: Europe/Bratislava\n`,
    'users/init.sls': `{% for user in pillar.get('admins', []) %}\n{{ user }}:\n  user.present:\n    - shell: /bin/bash\n    - groups: [sudo]\n{% endfor %}\n`,
    'webserver/init.sls': `nginx:\n  pkg.installed: []\n  service.running:\n    - enable: True\n    - watch:\n      - file: /etc/nginx/sites-enabled/default\n\n/etc/nginx/sites-enabled/default:\n  file.managed:\n    - source: salt://webserver/files/default.conf.j2\n    - template: jinja\n`,
    'webserver/files/default.conf.j2': `server {\n    listen 80 default_server;\n    server_name {{ pillar['site_name'] }};\n    root /var/www/html;\n}\n`,
    'postgres/init.sls': `postgresql:\n  pkg.installed: []\n  service.running:\n    - enable: True\n`,
  },
  pillar: {
    'top.sls': `base:\n  '*':\n    - common\n  'roles:web':\n    - match: grain\n    - web\n  'db-*':\n    - db\n`,
    'common.sls': `env: lab\nadmins:\n  - pipo\n  - ops\nntp_servers:\n  - 0.pool.ntp.org\n  - 1.pool.ntp.org\n`,
    'web.sls': `site_name: shaker.lab.internal\nworkers: 4\n`,
    'db.sls': `postgres:\n  version: 16\n  max_connections: 200\n`,
  },
}

const pillarFor = (id: string): Record<string, unknown> => {
  const base: Record<string, unknown> = { env: 'lab', admins: ['pipo', 'ops'], ntp_servers: ['0.pool.ntp.org', '1.pool.ntp.org'] }
  if (id.startsWith('web')) Object.assign(base, { site_name: 'shaker.lab.internal', workers: 4 })
  if (id.startsWith('db')) Object.assign(base, { postgres: { version: 16, max_connections: 200 } })
  return base
}

// ---------- jobs ----------

interface MockJob extends JobSummary {
  jid: string
  minions: string[]
  results: Record<string, { at: number; ret: unknown }>
}

const jobs: MockJob[] = []

function newJid(date = new Date()) {
  const p = (n: number, l = 2) => String(n).padStart(l, '0')
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}${p(date.getMilliseconds() * 1000 + rand(0, 999), 6)}`
}

function startTime(date: Date) {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  return `${date.getFullYear()}, ${months[date.getMonth()]} ${String(date.getDate()).padStart(2, '0')} ${date.toTimeString().slice(0, 8)}.${String(date.getMilliseconds()).padStart(3, '0')}000`
}

function matchTarget(tgt: string, tgtType: string): string[] {
  const ids = keys.minions
  if (tgtType === 'list') {
    const list = tgt.split(',').map((s) => s.trim())
    return ids.filter((id) => list.includes(id))
  }
  if (tgtType === 'grain') {
    const [k, v] = tgt.split(':')
    return ids.filter((id) => {
      const g = minions[id]?.grains[k]
      return Array.isArray(g) ? g.map(String).includes(v) : String(g) === v
    })
  }
  if (tgtType === 'pcre') {
    try {
      const re = new RegExp(tgt)
      return ids.filter((id) => re.test(id))
    } catch {
      return []
    }
  }
  if (tgtType === 'compound') {
    // Good enough for the demo: handle "G@k:v", "L@a,b" and globs joined by "or".
    return [...new Set(tgt.split(/\s+or\s+/).flatMap((part) => {
      if (part.startsWith('G@')) return matchTarget(part.slice(2), 'grain')
      if (part.startsWith('L@')) return matchTarget(part.slice(2), 'list')
      return matchTarget(part, 'glob')
    }))]
  }
  const re = new RegExp(`^${tgt.replace(/[.+^${}()|\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`)
  return ids.filter((id) => re.test(id))
}

function stateResults(id: string, sls: string[], test: boolean) {
  const g = minions[id].grains
  const states: Array<[string, string, string, Record<string, unknown>]> = [
    ['file', 'motd', '/etc/motd', { diff: `--- \n+++ \n@@ -1 +1 @@\n-Welcome\n+Managed by Salt — ${id}\n` }],
    ['pkg', 'base-tools', 'base-tools', {}],
    ['timezone', 'timezone', 'Europe/Bratislava', {}],
    ['user', 'pipo', 'pipo', {}],
    ['user', 'ops', 'ops', {}],
  ]
  if ((g.roles as string[]).includes('web') && (sls.length === 0 || sls.includes('webserver'))) {
    states.push(['pkg', 'nginx', 'nginx', {}], ['service', 'nginx', 'nginx', {}], ['file', '/etc/nginx/sites-enabled/default', '/etc/nginx/sites-enabled/default', {}])
  }
  if (id.startsWith('db')) states.push(['pkg', 'postgresql', 'postgresql', {}], ['service', 'postgresql', 'postgresql', {}])

  const out: Record<string, unknown> = {}
  states.forEach(([mod, sid, name, changes], i) => {
    const fail = !test && id === 'web-02' && sid === 'nginx' && mod === 'service'
    const changed = Object.keys(changes).length > 0 && Math.random() > 0.3
    const fun = mod === 'pkg' ? 'installed' : mod === 'service' ? 'running' : mod === 'user' ? 'present' : mod === 'timezone' ? 'system' : 'managed'
    out[`${mod}_|-${sid}_|-${name}_|-${fun}`] = {
      __id__: sid,
      __run_num__: i,
      __sls__: mod === 'user' ? 'users' : sid.includes('nginx') ? 'webserver' : 'common',
      name,
      result: fail ? false : test && changed ? null : true,
      comment: fail
        ? 'Job for nginx.service failed because the control process exited with error code.'
        : changed
          ? test ? `The file ${name} is set to be changed` : `File ${name} updated`
          : mod === 'pkg' ? 'All specified packages are already installed' : mod === 'service' ? `The service ${name} is already running` : `${mod}.${fun} is in the correct state`,
      changes: changed ? changes : {},
      duration: Math.round(Math.random() * 400 * 100) / 100,
      start_time: new Date().toTimeString().slice(0, 15),
    }
  })
  return out
}

function execute(id: string, fun: string, arg: unknown[], kwarg: Record<string, unknown>): unknown {
  const m = minions[id]
  const g = m.grains
  switch (fun) {
    case 'test.ping':
      return true
    case 'test.version':
      return g.saltversion
    case 'grains.items':
      return g
    case 'grains.item':
      return Object.fromEntries(arg.map((k) => [k, g[String(k)] ?? '']))
    case 'grains.get':
      return g[String(arg[0])] ?? ''
    case 'pillar.items':
      return pillarFor(id)
    case 'pillar.get':
      return pillarFor(id)[String(arg[0])] ?? ''
    case 'state.apply':
    case 'state.highstate':
    case 'state.sls': {
      const sls = String(arg[0] ?? '').split(',').filter(Boolean)
      return stateResults(id, sls, kwarg.test === true || kwarg.test === 'True')
    }
    case 'cmd.run': {
      const cmd = String(arg[0] ?? '')
      if (cmd.startsWith('uptime')) return ` ${new Date().toTimeString().slice(0, 8)} up ${rand(2, 90)} days,  ${rand(0, 23)}:${String(rand(0, 59)).padStart(2, '0')},  0 users,  load average: 0.${rand(0, 99)}, 0.${rand(0, 99)}, 0.${rand(0, 99)}`
      if (cmd.startsWith('hostname')) return id
      if (cmd.startsWith('df')) return `Filesystem      Size  Used Avail Use% Mounted on\n/dev/vda1        78G   ${rand(9, 60)}G   ${rand(10, 60)}G  ${rand(12, 80)}% /\ntmpfs           2.0G     0  2.0G   0% /dev/shm`
      if (cmd.startsWith('uname')) return `Linux ${id} ${g.kernelrelease} x86_64 GNU/Linux`
      if (cmd.startsWith('whoami')) return 'root'
      if (cmd.startsWith('free')) return `               total        used        free\nMem:      ${g.mem_total}000   ${rand(900, 3000)}000   ${rand(500, 3000)}000`
      return `[demo] ${cmd}: executed on ${id}`
    }
    case 'pkg.list_upgrades':
      return id.startsWith('web') ? { openssl: '3.0.13-0ubuntu3.4', 'libssl3t64': '3.0.13-0ubuntu3.4' } : {}
    case 'service.status':
      return id === 'web-02' && arg[0] === 'nginx' ? false : true
    case 'status.uptime':
      return { days: rand(1, 90), seconds: rand(1e5, 8e6), since_iso: '2026-09-14T08:12:44', users: 0 }
    case 'disk.usage':
      return { '/': { filesystem: '/dev/vda1', '1K-blocks': '81106868', used: '23124912', available: '57965572', capacity: `${rand(15, 80)}%` } }
    case 'network.ip_addrs':
      return (g.ipv4 as string[]).filter((ip) => ip !== '127.0.0.1')
    case 'sys.list_functions':
      return FUNCTIONS
    case 'saltutil.sync_all':
      return { modules: [], states: [], grains: [], beacons: [] }
    default:
      return `'${fun}' is not available.`
  }
}

const FUNCTIONS = [
  'cmd.run', 'cmd.script', 'cp.get_file', 'disk.usage', 'file.read', 'file.write', 'grains.get', 'grains.item', 'grains.items', 'grains.setval',
  'network.interfaces', 'network.ip_addrs', 'pillar.get', 'pillar.items', 'pkg.install', 'pkg.list_pkgs', 'pkg.list_upgrades', 'pkg.remove', 'pkg.upgrade',
  'saltutil.refresh_pillar', 'saltutil.sync_all', 'service.restart', 'service.start', 'service.status', 'service.stop', 'state.apply', 'state.highstate',
  'state.show_sls', 'state.show_top', 'state.sls', 'status.uptime', 'sys.doc', 'sys.list_functions', 'test.ping', 'test.version', 'user.list_users',
]

// ---------- events ----------

const listeners = new Set<(e: SaltEvent) => void>()
const emit = (tag: string, data: Record<string, unknown>) => {
  const e = { tag, data: { ...data, _stamp: new Date().toISOString() } }
  listeners.forEach((l) => l(e))
}

function startJob(tgt: string, tgtType: string, fun: string, arg: unknown[], kwarg: Record<string, unknown>, user: string, when = new Date(), instant = false) {
  const matched = matchTarget(tgt, tgtType)
  if (matched.length === 0) return null
  const jid = newJid(when)
  const job: MockJob = {
    jid,
    Function: fun,
    Arguments: Object.keys(kwarg).length ? [...arg, { __kwarg__: true, ...kwarg }] : arg,
    Target: tgt,
    'Target-type': tgtType,
    User: user,
    StartTime: startTime(when),
    minions: matched,
    results: {},
  }
  for (const id of matched) {
    if (!minions[id].up) continue
    const delay = instant ? 0 : fun.startsWith('state.') ? rand(1200, 3500) : rand(150, 900)
    job.results[id] = { at: when.getTime() + delay, ret: execute(id, fun, arg, kwarg) }
    if (!instant) {
      setTimeout(() => emit(`salt/job/${jid}/ret/${id}`, { id, jid, fun, return: job.results[id].ret, success: true }), delay)
    }
  }
  jobs.unshift(job)
  if (!instant) emit(`salt/job/${jid}/new`, { jid, tgt, tgt_type: tgtType, fun, arg, minions: matched, user })
  return job
}

// seed history
;(() => {
  const now = Date.now()
  const seed: Array<[number, string, string, string, unknown[], Record<string, unknown>]> = [
    [180, '*', 'glob', 'test.ping', [], {}],
    [150, 'web-*', 'glob', 'state.apply', [], { test: true }],
    [140, 'web-*', 'glob', 'state.apply', [], {}],
    [95, 'roles:db', 'grain', 'cmd.run', ['df -h'], {}],
    [60, '*', 'glob', 'pkg.list_upgrades', [], {}],
    [30, 'mon-01', 'glob', 'service.status', ['prometheus'], {}],
    [12, '*', 'glob', 'state.apply', ['common'], {}],
    [3, '*', 'glob', 'test.ping', [], {}],
  ]
  for (const [minsAgo, tgt, type, fun, arg, kwarg] of seed) startJob(tgt, type, fun, arg, kwarg, 'pipo', new Date(now - minsAgo * 60_000), true)
  jobs.sort((a, b) => b.jid.localeCompare(a.jid))
})()

function lookup(jid: string) {
  const job = jobs.find((j) => j.jid === jid)
  if (!job) return {}
  const now = Date.now()
  return Object.fromEntries(Object.entries(job.results).filter(([, r]) => r.at <= now).map(([id, r]) => [id, r.ret]))
}

function buildTree(paths: string[]): FileTree {
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

const wheelOk = (fun: string, ret: unknown) => {
  const jid = newJid()
  return { tag: `salt/wheel/${jid}`, data: { fun: `wheel.${fun}`, jid, _stamp: new Date().toISOString().slice(0, -1), return: ret, success: true } }
}

function moveKey(id: string, to: keyof KeyList) {
  for (const k of ['minions', 'minions_pre', 'minions_rejected', 'minions_denied'] as const) keys[k] = keys[k].filter((x) => x !== id)
  if (to !== 'local') (keys[to] as string[]).push(id)
}

function ensureMinion(id: string) {
  if (!minions[id]) minions[id] = { up: true, grains: makeGrains(id, 'Ubuntu', '24.04', 2, 3934, `10.0.9.${rand(10, 250)}`, []) }
}

function matchKeys(match: string, lists: Array<keyof KeyList>) {
  const re = new RegExp(`^${match.replace(/[.+^${}()|\\]/g, '\\$&').replace(/\*/g, '.*')}$`)
  return lists.flatMap((l) => (keys[l] ?? []).filter((id) => re.test(id)))
}

function fakeKey(kind: 'PUBLIC' | 'PRIVATE') {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  const body = Array.from({ length: kind === 'PUBLIC' ? 6 : 25 }, () => Array.from({ length: 64 }, () => chars[rand(0, 63)]).join('')).join('\n')
  return `-----BEGIN ${kind === 'PUBLIC' ? 'PUBLIC' : 'RSA PRIVATE'} KEY-----\n${body}\n-----END ${kind === 'PUBLIC' ? 'PUBLIC' : 'RSA PRIVATE'} KEY-----`
}

function fingerprint(id: string) {
  let h = 0
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0
  return Array.from({ length: 32 }, (_, i) => ((h >> (i % 24)) ^ (i * 37)) & 0xff).map((b) => b.toString(16).padStart(2, '0')).join(':')
}

export class MockTransport implements Transport {
  private user = 'demo'

  async login(username: string, _password: string, eauth: string): Promise<Session> {
    await sleep(350)
    this.user = username || 'demo'
    return { token: 'demo-token', expire: Date.now() / 1000 + 12 * 3600, user: this.user, eauth, perms: ['.*', '@wheel', '@runner', '@jobs'] }
  }

  async logout() {}

  async call(low: Lowstate): Promise<unknown> {
    await sleep(rand(120, 380))
    const { client, fun } = low
    const kw = low as Record<string, unknown>

    if (client === 'local' || client === 'local_async') {
      const job = startJob(low.tgt ?? '*', low.tgt_type ?? 'glob', fun, low.arg ?? [], low.kwarg ?? {}, this.user, new Date(), client === 'local')
      if (client === 'local_async') return job ? { jid: job.jid, minions: job.minions } : ''
      if (!job) return {}
      return Object.fromEntries(Object.entries(job.results).map(([id, r]) => [id, r.ret]))
    }

    if (client === 'runner') {
      switch (fun) {
        case 'manage.status':
          return { up: keys.minions.filter((id) => minions[id]?.up), down: keys.minions.filter((id) => !minions[id]?.up) }
        case 'pillar.show_pillar':
          return pillarFor(String(kw.minion))
        case 'jobs.list_jobs':
          return Object.fromEntries(jobs.map(({ jid, Function, Arguments, Target, User, StartTime, ...rest }) => [jid, { Function, Arguments, Target, 'Target-type': rest['Target-type'], User, StartTime }]))
        case 'jobs.lookup_jid':
          return lookup(String(kw.jid))
        case 'jobs.list_job': {
          const job = jobs.find((j) => j.jid === kw.jid)
          if (!job) return {}
          const ret = lookup(job.jid)
          return {
            jid: job.jid,
            Function: job.Function,
            Arguments: job.Arguments,
            Target: job.Target,
            'Target-type': job['Target-type'],
            User: job.User,
            StartTime: job.StartTime,
            Minions: job.minions,
            Result: Object.fromEntries(Object.entries(ret).map(([id, r]) => [id, { return: r, retcode: 0, success: true }])),
          }
        }
      }
      throw new SaltError(`Runner '${fun}' is not available in demo mode`, 500)
    }

    if (client === 'wheel') {
      switch (fun) {
        case 'key.list_all':
          return wheelOk(fun, { ...keys, local: ['master.pem', 'master.pub'] })
        case 'key.finger': {
          const out: Record<string, Record<string, string>> = {}
          for (const l of ['minions', 'minions_pre', 'minions_rejected', 'minions_denied'] as const) {
            out[l] = Object.fromEntries(keys[l].map((id) => [id, fingerprint(id)]))
          }
          return wheelOk(fun, out)
        }
        case 'key.accept': {
          const ids = matchKeys(String(kw.match), ['minions_pre', 'minions_rejected', 'minions_denied'])
          ids.forEach((id) => {
            moveKey(id, 'minions')
            ensureMinion(id)
            emit('salt/key', { id, act: 'accept', result: true })
          })
          return wheelOk(fun, { minions: ids })
        }
        case 'key.reject': {
          const ids = matchKeys(String(kw.match), ['minions_pre', 'minions', 'minions_denied'])
          ids.forEach((id) => {
            moveKey(id, 'minions_rejected')
            emit('salt/key', { id, act: 'reject', result: true })
          })
          return wheelOk(fun, { minions_rejected: ids })
        }
        case 'key.delete': {
          const ids = matchKeys(String(kw.match), ['minions_pre', 'minions', 'minions_rejected', 'minions_denied'])
          ids.forEach((id) => {
            moveKey(id, 'local')
            emit('salt/key', { id, act: 'delete', result: true })
          })
          return wheelOk(fun, {})
        }
        case 'key.gen_accept': {
          const id = String(kw.id_)
          if (keys.minions.includes(id)) return { tag: '', data: { fun, return: `Minion ${id} already exists`, success: false } }
          moveKey(id, 'minions')
          ensureMinion(id)
          minions[id].up = false
          emit('salt/key', { id, act: 'accept', result: true })
          return wheelOk(fun, { pub: fakeKey('PUBLIC'), priv: fakeKey('PRIVATE') })
        }
        case 'file_roots.list_roots':
          return wheelOk(fun, { base: [{ '/srv/salt': buildTree(Object.keys(files.file)) }] })
        case 'pillar_roots.list_roots':
          return wheelOk(fun, { base: [{ '/srv/pillar': buildTree(Object.keys(files.pillar)) }] })
        case 'file_roots.read':
        case 'pillar_roots.read': {
          const kind = fun.startsWith('file') ? 'file' : 'pillar'
          const path = String(kw.path)
          const content = files[kind][path]
          if (content === undefined) return wheelOk(fun, 'File not found')
          return wheelOk(fun, [{ [`/srv/${kind === 'file' ? 'salt' : 'pillar'}/${path}`]: content }])
        }
      }
      throw new SaltError(`Wheel '${fun}' is not available in demo mode`, 500)
    }

    throw new SaltError(`Unknown client ${client}`, 400)
  }

  events(_token: string, onEvent: (e: SaltEvent) => void, onStatus: (connected: boolean) => void) {
    listeners.add(onEvent)
    setTimeout(() => onStatus(true), 200)
    // background chatter so the feed feels alive
    const timer = setInterval(() => {
      const up = keys.minions.filter((id) => minions[id]?.up)
      const id = up[rand(0, up.length - 1)]
      const pick = rand(0, 9)
      if (pick < 6) emit(`minion/refresh/${id}`, { Minion_data_cache_refresh: id })
      else if (pick < 8) emit(`salt/beacon/${id}/load/`, { id, '1m': Math.random().toFixed(2), '5m': Math.random().toFixed(2), '15m': Math.random().toFixed(2) })
      else if (keys.minions_pre.length) emit('salt/auth', { id: keys.minions_pre[0], act: 'pend', result: true, pub: '-----BEGIN PUBLIC KEY-----…' })
    }, 4000)
    return () => {
      listeners.delete(onEvent)
      clearInterval(timer)
    }
  }
}
