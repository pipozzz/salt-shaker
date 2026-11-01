# Salt Shaker

A web UI for SaltStack, built with React, Vite, TypeScript and Tailwind. It talks to the master through **salt-api** (`rest_cherrypy`), so you don't need a separate backend.

| Page | What it does |
| --- | --- |
| **Minions** | Lists accepted minions with up/down status, OS, IP, CPU/RAM and roles. The detail page shows grains and pillar, with quick actions. |
| **Compliance** | Runs a dry-run highstate (`state.apply test=True`) across a target and sorts minions into in compliance, drifted, errors and no return. Expand a minion to see what would change, and remediate drifted minions with one click. The last check is remembered. |
| **Patches** | Scans for pending package upgrades (`pkg.list_upgrades`) and shows them by package or by minion, with installed → available versions. You can upgrade one package where it's pending (`pkg.install only_upgrade=True`) or upgrade everything on a minion (`pkg.upgrade`), after a confirmation. |
| **Enrollment** | Accept or reject pending keys (with fingerprints), reject or delete keys, and enroll new minions with a bootstrap script. Enrollment works either as "install, then approve" or with pre-seeded keys via `key.gen_accept`. |
| **Run** | Runs any execution module against a glob, list, grain, compound, pcre, pillar or nodegroup target. Before you run, it previews which minions the target matches (from the master cache, so nothing executes). Returns stream in live over the event bus, and minions that are offline are detected with `saltutil.find_job` instead of waiting for a timeout. State output is rendered with ok/changed/failed counts and diffs. Keeps a history of recent commands. |
| **Jobs** | The job cache history. The detail page shows results and has a "Run again" button. |
| **States & Pillar** | Browse `file_roots` and `pillar_roots` with syntax highlighting, and see a minion's compiled pillar. |
| **Events** | A live stream from the master event bus, with filters. |

Every page that takes a target previews the minions it matches, and you can save named targets (such as `webservers` = `G@roles:web`) for reuse. Toast notifications pop up when a job fails on any minion (from any client, not just this UI) and when a new minion is waiting for approval.

There is also a **Demo** mode on the login screen. It runs a simulated master in the browser, so you can try the UI without Salt.

## Quick start

```bash
npm install
npm run dev
```

Open http://localhost:5173 and pick **Demo**, or sign in through salt-api.

In dev, Vite proxies `/salt-api` to `http://localhost:8000`. Point it somewhere else with `SALT_API_URL=https://master:8000 npm run dev`.

## Local Salt lab

`lab/` contains a docker-compose setup with one master (salt-api on `:8000`) and three minions (`web-01`, `web-02`, `db-01`):

```bash
cd lab && docker compose up -d --build
```

Sign in with URL `/salt-api`, user `shaker`, password `shaker` and eauth `sharedsecret`. The minion keys start out pending, so accept them on the **Enrollment** page. These credentials are for the lab only.

## Configuring salt-api on a real master

```yaml
# /etc/salt/master.d/api.conf
rest_cherrypy:
  port: 8000
  ssl_crt: /etc/pki/tls/certs/localhost.crt
  ssl_key: /etc/pki/tls/certs/localhost.key

# Salt 3006+ disables all netapi clients by default
netapi_enable_clients: [local, local_async, runner, wheel]

external_auth:
  pam:
    saltadmins%:          # Linux group
      - '.*'
      - '@wheel'          # keys, file_roots
      - '@runner'         # manage.status, jobs, pillar.show_pillar
      - '@jobs'
```

The UI uses these:

- `wheel`: `key.*`, `file_roots.*` and `pillar_roots.*`
- `runner`: `manage.status`, `cache.grains` (target preview), `jobs.*` and `pillar.show_pillar`
- `local`/`local_async`: everything else

The `/events` stream authenticates with the `X-Auth-Token` header, because recent salt-api versions reject a token in the query string.

## Production

`npm run build` produces static files in `dist/`. Serve them from the same origin as salt-api, for example with nginx: put `/` on `dist/` and `/salt-api/` as a `proxy_pass` to `rest_cherrypy`, with `proxy_buffering off` for SSE. If the UI and salt-api run on different origins, set `VITE_SALT_API_URL` at build time and configure CORS on salt-api.
