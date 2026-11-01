# Salt Shaker

A web UI for SaltStack, built with React, Vite, TypeScript and Tailwind. It talks to the master through **salt-api** (`rest_cherrypy`), so you don't need a separate backend.

| Page | What it does |
| --- | --- |
| **Minions** | Lists accepted minions with up/down status, OS, IP, CPU/RAM and roles. The detail page shows grains and pillar, with quick actions. |
| **Compliance** | Runs a dry-run highstate (`state.apply test=True`) across a target and sorts minions into in compliance, drifted, errors and no return. Expand a minion to see what would change, and remediate drifted minions with one click. The last check is remembered. |
| **Patches** | Scans for pending package upgrades (`pkg.list_upgrades`) and shows them by package or by minion, with installed → available versions. You can upgrade one package where it's pending (`pkg.install only_upgrade=True`) or upgrade everything on a minion (`pkg.upgrade`), after a confirmation. |
| **Enrollment** | Accept or reject pending keys (with fingerprints), reject or delete keys, and enroll new minions with a bootstrap script. Enrollment works either as "install, then approve" or with pre-seeded keys via `key.gen_accept`. |
| **Run** | Runs any execution module against a glob, list, grain, compound, pcre, pillar or nodegroup target. Before you run, it previews which minions the target matches (from the master cache, so nothing executes). Returns stream in live over the event bus, and minions that are offline are detected with `saltutil.find_job` instead of waiting for a timeout. State output is rendered with ok/changed/failed counts and diffs. Keeps a history of recent commands. |
| **Orchestrate** | Lists orchestration SLS files under `orch/` and shows their source. Runs them with `state.orchestrate`, optionally as a dry run and with pillar overrides, in the background (`runner_async`, falling back to the sync runner). Each step's result is shown with nested per-minion output, and recent runs are kept. |
| **Jobs** | The job cache history. The detail page shows results and has a "Run again" button. |
| **States & Pillar** | Browse `file_roots` and `pillar_roots` with syntax highlighting, and see a minion's compiled pillar. |
| **Events** | A live stream from the master event bus, with filters. |

Press **⌘K / Ctrl+K** anywhere to jump to a page, minion, saved target or recent command, open a job by jid, or start typing a function to run it.

The UI reads the eauth `perms` that salt-api returns at login and disables what your account can't do (for example a read-only user can browse but not accept keys, run `cmd.run` or upgrade packages). The master still enforces the permissions; the UI only avoids offering actions that would fail.

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

Sign in with URL `/salt-api`, user `shaker`, password `shaker` and eauth `sharedsecret` (full access), or as `viewer` / `viewer` with eauth `file` (read-only, to see the permission-aware UI). The master's keys are kept in a Docker volume, so re-creating the container doesn't break the minions. The minion keys start out pending, so accept them on the **Enrollment** page. These credentials are for the lab only.

## Configuring salt-api on a real master

```yaml
# /etc/salt/master.d/api.conf
rest_cherrypy:
  port: 8000
  ssl_crt: /etc/pki/tls/certs/localhost.crt
  ssl_key: /etc/pki/tls/certs/localhost.key

# Salt 3006+ disables all netapi clients by default
netapi_enable_clients: [local, local_async, runner, runner_async, wheel]

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

The repo ships a production image: nginx serves the built UI and proxies `/salt-api/` to `rest_cherrypy` on the same origin, so CORS isn't needed. Response buffering is turned off so the `/events` stream works. It also sets security headers including a CSP, and exposes `/healthz`.

```bash
docker build -t salt-shaker .
```
```bash
docker run -d -p 8080:8080 -e SALT_API_URL=http://salt-master:8000 salt-shaker
```

nginx resolves the salt-api host per request, so the UI starts even when the master is down and recovers once it's back. Put TLS in front of it (a load balancer, Traefik and so on). The lab compose already runs this image as `ui` at http://localhost:8080.

To serve the static `dist/` some other way (`npm run build`), proxy `/salt-api/` to salt-api with buffering off. If the UI and salt-api must live on different origins, build with `VITE_SALT_API_URL=https://master:8000` and enable CORS on salt-api.

## Development

```bash
npm run lint
```
```bash
npm run typecheck
```
```bash
npm test
```

The unit tests in `src/**/*.test.ts` cover argument parsing, eauth permission matching, compliance classification and the salt-api quirks found on Salt 3007 (jid clock offset, `lookup_jid` envelopes, `key.gen_accept` and runner returns). GitHub Actions runs lint, typecheck, tests and the build on every push and PR, then builds the Docker image and smoke-tests it.
