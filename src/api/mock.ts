import type { HistoryJob, MinionUpdates } from './server'
import { OSQUERY_INSTALL_MARKER } from '../lib/osquery'
import { demoOsquery } from './demo-osquery'
import { recordDemoAudit, saltArgs } from './demo-audit'
import { isAudited } from '../lib/readonly'
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
  'mon-01': { up: true, grains: { ...makeGrains('mon-01', 'Rocky', '9.4', 2, 3934, '10.0.3.41', ['monitoring']), saltversion: '3006.9' } },
  'worker-01': { up: true, grains: makeGrains('worker-01', 'Ubuntu', '22.04', 16, 64220, '10.0.4.51', ['worker']) },
}

/**
 * `?demo=large` (remembered for the tab) adds a few hundred generated minions, to see how the
 * UI copes with a big fleet. Seeded, so every load looks the same.
 */
const LARGE_FLEET = (() => {
  try {
    if (new URLSearchParams(window.location.search).get('demo') === 'large') sessionStorage.setItem('salt-shaker.demo', 'large')
    return sessionStorage.getItem('salt-shaker.demo') === 'large'
  } catch {
    return false
  }
})()

if (LARGE_FLEET) {
  let seed = 42
  const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648
  const sites = ['fra', 'ams', 'lon', 'nyc']
  const kinds: Array<[string, string[], string, string]> = [
    ['web', ['web', 'nginx'], 'Ubuntu', '24.04'],
    ['api', ['api'], 'Ubuntu', '22.04'],
    ['db', ['db', 'postgres'], 'Debian', '12'],
    ['cache', ['cache', 'redis'], 'Debian', '12'],
    ['worker', ['worker'], 'Rocky', '9.4'],
  ]
  for (let i = 1; i <= 600; i++) {
    const [kind, roles, os, rel] = kinds[i % kinds.length]
    const id = `${kind}-${sites[i % sites.length]}-${String(i).padStart(3, '0')}`
    const g = makeGrains(id, os, rel, [2, 4, 8, 16][i % 4], [3934, 7951, 15903, 32093][i % 4], `10.${1 + (i % 4)}.${Math.floor(i / 250)}.${i % 250}`, roles)
    // a slice of the fleet lags behind on Salt, and a few minions are down
    if (next() < 0.08) g.saltversion = '3006.9'
    minions[id] = { up: next() > 0.04, grains: g }
  }
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
    'orch/deploy.sls': `# Roll out the baseline, then the web tier, then check everyone answers.\napply_common:\n  salt.state:\n    - tgt: '*'\n    - sls: common\n\nweb_tier:\n  salt.state:\n    - tgt: 'roles:web'\n    - tgt_type: grain\n    - sls: webserver\n    - require:\n      - salt: apply_common\n\nping_all:\n  salt.function:\n    - name: test.ping\n    - tgt: '*'\n    - require:\n      - salt: web_tier\n`,
    'orch/rolling_restart.sls': `{% for host in ['web-01', 'web-02'] %}\nrestart_{{ host }}:\n  salt.function:\n    - name: service.restart\n    - tgt: {{ host }}\n    - arg: [nginx]\n{% endfor %}\n`,
    'postgres/init.sls': `postgresql:\n  pkg.installed: []\n  service.running:\n    - enable: True\n`,
  },
  pillar: {
    'top.sls': `base:\n  '*':\n    - common\n  'roles:web':\n    - match: grain\n    - web\n  'db-*':\n    - db\n`,
    'common.sls': `env: lab\nadmins:\n  - pipo\n  - ops\nntp_servers:\n  - 0.pool.ntp.org\n  - 1.pool.ntp.org\n`,
    'web.sls': `site_name: shaker.lab.internal\nworkers: 4\n`,
    'db.sls': `postgres:\n  version: 16\n  max_connections: 200\n`,
  },
}

// pending package upgrades per minion: name -> [installed, available]
const upgrades: Record<string, Record<string, [string, string]>> = {}
for (const [id, m] of Object.entries(minions)) {
  const os = m.grains.os
  const u: Record<string, [string, string]> = {}
  if (os === 'Ubuntu') Object.assign(u, { openssl: ['3.0.13-0ubuntu3.4', '3.0.13-0ubuntu3.5'], libssl3t64: ['3.0.13-0ubuntu3.4', '3.0.13-0ubuntu3.5'], tzdata: ['2026a-0ubuntu0.24.04', '2026f-0ubuntu0.24.04'] })
  if (os === 'Debian') Object.assign(u, { tzdata: ['2026a-0+deb12u1', '2026f-0+deb12u1'], 'linux-image-amd64': ['6.1.112-1', '6.1.119-1'] })
  if (os === 'Rocky') Object.assign(u, { kernel: ['5.14.0-503.11.1.el9_5', '5.14.0-503.14.1.el9_5'], curl: ['7.76.1-29.el9_4', '7.76.1-31.el9'] })
  if (id === 'web-01') u.nginx = ['1.24.0-2ubuntu7', '1.24.0-2ubuntu7.1']
  if (id === 'worker-01') delete u.openssl
  upgrades[id] = u
}

function applyUpgrades(id: string, only?: string[]) {
  const done: Record<string, { old: string; new: string }> = {}
  for (const [name, [old, nw]] of Object.entries(upgrades[id] ?? {})) {
    if (only && !only.includes(name)) continue
    done[name] = { old, new: nw }
    delete upgrades[id][name]
  }
  return done
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
  results: Record<string, { at: number; ret: unknown; pid: number; timer?: ReturnType<typeof setTimeout> }>
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

function stateResults(id: string, sls: string[], test: boolean, saltenv?: string) {
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
  // the nginx-tls branch: a TLS config for the web tier (nginx reloads for it), and no ops user any more
  const tls = saltenv === 'nginx-tls'
  if (tls && (g.roles as string[]).includes('web')) {
    states.push(['file', '/etc/nginx/conf.d/tls.conf', '/etc/nginx/conf.d/tls.conf', { diff: 'New file' }])
    const svc = states.findIndex(([m, s]) => m === 'service' && s === 'nginx')
    if (svc >= 0) states[svc] = ['service', 'nginx', 'nginx', { reload: true }]
  }
  if (tls) states.splice(states.findIndex(([m, s]) => m === 'user' && s === 'ops'), 1)

  const out: Record<string, unknown> = {}
  states.forEach(([mod, sid, name, changes], i) => {
    const fail = !test && id === 'web-02' && sid === 'nginx' && mod === 'service'
    // web-01's motd always drifts, so every compliance check has something to remediate; the rest is chance
    // with a saltenv named (a branch preview) the outcome is fixed, so base and the branch compare cleanly
    const changed = Object.keys(changes).length > 0 && (id === 'web-01' || (saltenv ? sid !== 'motd' : Math.random() > 0.3))
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
      return stateResults(id, sls, kwarg.test === true || kwarg.test === 'True', typeof kwarg.saltenv === 'string' ? kwarg.saltenv : undefined)
    }
    case 'cmd.run': {
      const cmd = String(arg[0] ?? '')
      if (cmd.startsWith('osqueryi') || cmd.includes(OSQUERY_INSTALL_MARKER)) return demoOsquery(id, String(g.os), String(g.osrelease), cmd, String(kwarg.stdin ?? ''))
      if (cmd.startsWith('uptime')) return ` ${new Date().toTimeString().slice(0, 8)} up ${rand(2, 90)} days,  ${rand(0, 23)}:${String(rand(0, 59)).padStart(2, '0')},  0 users,  load average: 0.${rand(0, 99)}, 0.${rand(0, 99)}, 0.${rand(0, 99)}`
      if (cmd.startsWith('hostname')) return id
      if (cmd.startsWith('df')) return `Filesystem      Size  Used Avail Use% Mounted on\n/dev/vda1        78G   ${rand(9, 60)}G   ${rand(10, 60)}G  ${rand(12, 80)}% /\ntmpfs           2.0G     0  2.0G   0% /dev/shm`
      if (cmd.startsWith('uname')) return `Linux ${id} ${g.kernelrelease} x86_64 GNU/Linux`
      if (cmd.startsWith('whoami')) return 'root'
      if (cmd.startsWith('free')) return `               total        used        free\nMem:      ${g.mem_total}000   ${rand(900, 3000)}000   ${rand(500, 3000)}000`
      return `[demo] ${cmd}: executed on ${id}`
    }
    case 'pkg.list_upgrades':
      return Object.fromEntries(Object.entries(upgrades[id] ?? {}).map(([name, [, nw]]) => [name, nw]))
    case 'pkg.version': {
      const ver = (name: string) => upgrades[id]?.[name]?.[0] ?? ''
      return arg.length === 1 ? ver(String(arg[0])) : Object.fromEntries(arg.map((n) => [n, ver(String(n))]))
    }
    case 'pkg.install':
      // only_upgrade semantics: never installs something new in the demo
      return applyUpgrades(id, (kwarg.pkgs as string[] | undefined) ?? arg.map(String))
    case 'pkg.upgrade':
      return applyUpgrades(id)
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
    case 'saltutil.find_job': {
      const job = jobs.find((j) => j.jid === arg[0])
      const r = job?.results[id]
      return r && r.at > Date.now() ? { jid: job.jid, fun: job.Function, pid: r.pid } : {}
    }
    case 'test.sleep':
      return true
    case 'saltutil.kill_job': {
      // the killed process never returns
      const job = jobs.find((j) => j.jid === arg[0])
      const r = job?.results[id]
      if (!job || !r || r.at <= Date.now()) return `No job ${String(arg[0])} running on ${id}`
      clearTimeout(r.timer)
      delete job.results[id]
      return `Signal 9 sent to job ${job.jid} at pid ${r.pid}`
    }
    case 'saltutil.sync_all':
      return { modules: [], states: [], grains: [], beacons: [] }
    default:
      return `'${fun}' is not available.`
  }
}

const FUNCTIONS = [
  'cmd.run', 'cmd.script', 'cp.get_file', 'disk.usage', 'file.read', 'file.write', 'grains.get', 'grains.item', 'grains.items', 'grains.setval',
  'network.interfaces', 'network.ip_addrs', 'pillar.get', 'pillar.items', 'pkg.install', 'pkg.list_pkgs', 'pkg.list_upgrades', 'pkg.remove', 'pkg.upgrade',
  'saltutil.kill_job', 'saltutil.refresh_pillar', 'saltutil.sync_all', 'service.restart', 'service.start', 'service.status', 'service.stop', 'state.apply', 'state.highstate',
  'state.show_sls', 'state.show_top', 'state.sls', 'status.uptime', 'sys.doc', 'sys.list_functions', 'test.ping', 'test.sleep', 'test.version', 'user.list_users',
]

// ---------- orchestration ----------

const runnerJobs = new Map<string, { at: number; ret: unknown }>()

function orchestrate(sls: string, test: boolean) {
  const up = keys.minions.filter((id) => minions[id]?.up)
  const web = up.filter((id) => (minions[id].grains.roles as string[]).includes('web'))
  type Step = [id: string, kind: 'state' | 'function', name: string, ret: Record<string, unknown>]
  const steps: Step[] =
    sls === 'orch.rolling_restart'
      ? web.map((id): Step => [`restart_${id}`, 'function', 'service.restart', { [id]: true }])
      : [
          ['apply_common', 'state', 'apply_common', Object.fromEntries(up.map((id) => [id, stateResults(id, ['common'], test)]))],
          ['web_tier', 'state', 'web_tier', Object.fromEntries(web.map((id) => [id, stateResults(id, ['webserver'], test)]))],
          ['ping_all', 'function', 'test.ping', Object.fromEntries(up.map((id) => [id, true]))],
        ]
  let failedBefore = false
  const data: Record<string, unknown> = {}
  steps.forEach(([sid, kind, name, ret], i) => {
    const failedMinions = kind === 'state' ? Object.entries(ret).filter(([, r]) => Object.values(r as object).some((st) => (st as { result: unknown }).result === false)).map(([m]) => m) : []
    const result = failedBefore ? false : failedMinions.length ? false : test ? null : true
    data[`salt_|-${sid}_|-${name}_|-${kind}`] = {
      __id__: sid,
      __run_num__: i,
      __sls__: sls,
      name,
      result,
      comment: failedBefore
        ? `One or more requisite failed: ${sls}.${steps[i - 1][0]}`
        : kind === 'function' && test
          ? `Function ${name} would be executed on target`
          : failedMinions.length
            ? `Run failed on minions: ${failedMinions.join(', ')}`
            : `States ran successfully. ${test ? 'No changes made.' : `Updating ${Object.keys(ret).join(', ')}.`}`,
      changes: failedBefore || (kind === 'function' && test) ? {} : { out: kind === 'state' ? 'highstate' : 'nested', ret },
      duration: rand(300, 4000),
      start_time: new Date().toTimeString().slice(0, 15),
    }
    if (result === false) failedBefore = true
  })
  return { data: { master_master: data }, outputter: 'highstate', retcode: failedBefore ? 1 : 0 }
}

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
    const delay = instant ? 0 : fun === 'test.sleep' ? Number(arg[0] ?? 1) * 1000 : fun.startsWith('state.') ? rand(1200, 3500) : rand(150, 900)
    job.results[id] = { at: when.getTime() + delay, ret: execute(id, fun, arg, kwarg), pid: rand(1000, 9999) }
    if (!instant) {
      const ret = job.results[id].ret
      const failed = failedReturn(ret)
      job.results[id].timer = setTimeout(() => emit(`salt/job/${jid}/ret/${id}`, { id, jid, fun, return: ret, retcode: failed ? 2 : 0, success: true }), delay)
    }
  }
  jobs.unshift(job)
  if (!instant) emit(`salt/job/${jid}/new`, { jid, tgt, tgt_type: tgtType, fun, arg, minions: matched, user })
  return job
}

/** A jid's start time: YYYYMMDDhhmmss… in local time, as newJid makes them. */
const jidTime = (jid: string) => new Date(+jid.slice(0, 4), +jid.slice(4, 6) - 1, +jid.slice(6, 8), +jid.slice(8, 10), +jid.slice(10, 12), +jid.slice(12, 14)).getTime()

/** Whether a minion's return counts as failed: a missing function, or a state that failed. */
function failedReturn(ret: unknown) {
  return (
    (typeof ret === 'string' && ret.endsWith('is not available.')) ||
    (!!ret && typeof ret === 'object' && Object.values(ret).some((v) => v && typeof v === 'object' && (v as { result?: unknown }).result === false))
  )
}

/** The demo's job history since `since`, newest first, shaped like the server's (returned and failed per job). */
export function demoJobHistory(since: number): HistoryJob[] {
  const now = Date.now()
  return jobs
    .map((j) => ({ j, at: jidTime(j.jid) }))
    .filter(({ at }) => at >= since)
    .sort((a, b) => b.at - a.at)
    .map(({ j, at }) => {
      const done = Object.values(j.results).filter((r) => r.at <= now)
      return {
        jid: j.jid,
        fun: j.Function,
        args: JSON.stringify(j.Arguments),
        target: String(j.Target),
        targetType: j['Target-type'],
        saltUser: j.User,
        shakerUser: j.User,
        minions: JSON.stringify(j.minions),
        dryRun: false,
        startedAt: new Date(at).toISOString(),
        returned: done.length,
        failed: done.filter((r) => failedReturn(r.ret)).length,
      }
    })
}

/** Which minions of a job have returned so far, and which of them failed. */
export function demoJobProgress(jid: string) {
  const j = jobs.find((x) => x.jid === jid)
  const now = Date.now()
  const done = Object.entries(j?.results ?? {}).filter(([, r]) => r.at <= now)
  return { returned: done.map(([m]) => m), failed: done.filter(([, r]) => failedReturn(r.ret)).map(([m]) => m), minions: j?.minions ?? [] }
}

/** Which minions a target matches in the demo, like cache.grains on a real master. */
export function demoMatch(tgt: string, tgtType: string) {
  return matchTarget(tgt, tgtType)
}

/** Each answering minion's pending upgrades, like the server keeps from its latest patch scan. */
export function demoPendingUpdates(checkedAt: string): Record<string, MinionUpdates> {
  return Object.fromEntries(Object.entries(upgrades).filter(([id]) => minions[id]?.up).map(([id, u]) => [id, { packages: Object.keys(u).length, jid: '', checkedAt }]))
}

/**
 * Starts a job as local_async would, for the demo's schedules: `when` in the past with `instant`
 * records an earlier run, otherwise it runs now and its returns stream in.
 */
export function demoJob(tgt: string, tgtType: string, fun: string, arg: unknown[], kwarg: Record<string, unknown>, user: string, when = new Date(), instant = false) {
  const job = startJob(tgt, tgtType, fun, arg, kwarg, user, when, instant)
  if (instant) jobs.sort((a, b) => b.jid.localeCompare(a.jid))
  // the server audits what its schedules start
  if (isAudited('local_async', fun)) recordDemoAudit({ at: when, username: user, role: 'system', client: 'local_async', fun, target: tgt, targetType: tgtType, args: saltArgs(arg, kwarg), jid: job?.jid ?? null, outcome: job ? 'ok' : 'error', error: job ? null : 'No minions matched the target', ip: null })
  return job ? { jid: job.jid, minions: job.minions } : null
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
    // one that failed, for the overview and the failed-jobs filter to show
    [50, 'web-02', 'glob', 'service.restart', ['nginx'], {}],
    [3, '*', 'glob', 'test.ping', [], {}],
  ]
  for (const [minsAgo, tgt, type, fun, arg, kwarg] of seed) {
    const when = new Date(now - minsAgo * 60_000)
    const job = startJob(tgt, type, fun, arg, kwarg, 'pipo', when, true)
    if (isAudited('local', fun)) recordDemoAudit({ at: when, username: 'pipo', role: 'operator', client: 'local', fun, target: tgt, targetType: type, args: saltArgs(arg, kwarg), jid: job?.jid ?? null, outcome: 'ok', ip: '10.0.9.4' })
  }
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

  /** Answers like salt-api, and audits it the way the server would. */
  async call(low: Lowstate): Promise<unknown> {
    const audited = isAudited(low.client, low.fun)
    const entry = { username: this.user, client: low.client, fun: low.fun, target: low.tgt ?? null, targetType: low.tgt_type ?? null, args: saltArgs(low.arg, low.kwarg) }
    try {
      const ret = await this.answer(low)
      const jid = ret && typeof ret === 'object' && 'jid' in ret ? String((ret as { jid: unknown }).jid) : null
      if (audited) recordDemoAudit({ ...entry, jid, outcome: 'ok' })
      return ret
    } catch (e) {
      if (audited) recordDemoAudit({ ...entry, outcome: 'error', error: e instanceof Error ? e.message : String(e) })
      throw e
    }
  }

  private async answer(low: Lowstate): Promise<unknown> {
    await sleep(rand(120, 380))
    const { client, fun } = low
    const kw = low as Record<string, unknown>

    if (client === 'local' || client === 'local_async') {
      const job = startJob(low.tgt ?? '*', low.tgt_type ?? 'glob', fun, low.arg ?? [], low.kwarg ?? {}, this.user, new Date(), client === 'local')
      if (client === 'local_async') return job ? { jid: job.jid, minions: job.minions } : ''
      if (!job) return {}
      return Object.fromEntries(Object.entries(job.results).map(([id, r]) => [id, r.ret]))
    }

    if (client === 'runner_async' || (client === 'runner' && fun === 'state.orchestrate')) {
      if (fun !== 'state.orchestrate') throw new SaltError(`Runner '${fun}' is not available in demo mode`, 500)
      const sls = String(low.arg?.[0] ?? kw.mods ?? '')
      if (!files.file[`${sls.replace(/\./g, '/')}.sls`]) throw new SaltError(`No such SLS: ${sls}`, 500)
      const ret = orchestrate(sls, low.kwarg?.test === true)
      if (client === 'runner') return ret
      const jid = newJid()
      const delay = rand(2500, 4500)
      runnerJobs.set(jid, { at: Date.now() + delay, ret })
      emit(`salt/run/${jid}/new`, { fun: 'runner.state.orchestrate', jid, user: this.user, fun_args: [sls] })
      setTimeout(() => emit(`salt/run/${jid}/ret`, { fun: 'runner.state.orchestrate', jid, user: this.user, return: ret, success: ret.retcode === 0 }), delay)
      return { tag: `salt/run/${jid}`, jid }
    }

    if (client === 'runner') {
      switch (fun) {
        case 'fileserver.envs':
          // base, and a gitfs branch with TLS for the web tier
          return ['base', 'nginx-tls']
        case 'manage.status':
          // like a real master, this waits for minions that don't answer
          await sleep(1200)
          return { up: keys.minions.filter((id) => minions[id]?.up), down: keys.minions.filter((id) => !minions[id]?.up) }
        case 'salt.cmd':
          if (low.arg?.[0] === 'test.version') return '3007.1'
          throw new SaltError(`salt.cmd ${String(low.arg?.[0])} is not available in demo mode`, 500)
        case 'cache.grains':
          return Object.fromEntries(matchTarget(String(kw.tgt), String(kw.tgt_type ?? 'glob')).map((id) => [id, minions[id].grains]))
        case 'pillar.show_pillar':
          return pillarFor(String(kw.minion))
        case 'jobs.active': {
          // like the real runner, this asks every minion what it is running
          await sleep(600)
          const now = Date.now()
          return Object.fromEntries(
            jobs
              .map((j) => ({ j, running: Object.entries(j.results).filter(([, r]) => r.at > now) }))
              .filter(({ running }) => running.length > 0)
              .map(({ j, running }) => [
                j.jid,
                { Function: j.Function, Arguments: j.Arguments, Target: j.Target, 'Target-type': j['Target-type'], User: j.User, StartTime: j.StartTime, Running: running.map(([id, r]) => ({ [id]: r.pid })), Returned: Object.keys(j.results).filter((id) => j.results[id].at <= now) },
              ]),
          )
        }
        case 'jobs.list_jobs':
          return Object.fromEntries(jobs.map(({ jid, Function, Arguments, Target, User, StartTime, ...rest }) => [jid, { Function, Arguments, Target, 'Target-type': rest['Target-type'], User, StartTime }]))
        case 'jobs.lookup_jid': {
          const rj = runnerJobs.get(String(kw.jid))
          if (rj) return rj.at <= Date.now() ? { master_master: { fun: 'runner.state.orchestrate', return: rj.ret, success: true } } : {}
          return lookup(String(kw.jid))
        }
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
