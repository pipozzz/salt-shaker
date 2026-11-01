# Salt Shaker

[![CI](https://github.com/pipozzz/salt-shaker/actions/workflows/ci.yml/badge.svg)](https://github.com/pipozzz/salt-shaker/actions/workflows/ci.yml)
[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue.svg)](LICENSE)

A web UI for [SaltStack](https://saltproject.io). It talks to your master through **salt-api** (`rest_cherrypy`), so there is nothing extra to run on the server side. It's a single static app, and you can try it in your browser without a Salt master.

![Minions overview](docs/screenshots/minions.png)

## Features

- **Minions:** status, OS, IPs, CPU/RAM and roles at a glance. A fleet breakdown flags minions running an older Salt than the master. Each minion's page shows its grains and compiled pillar.
- **Compliance:** dry-runs the highstate (`test=True`) across a target, then groups minions into *in compliance*, *drifted*, *errors* and *no return*, with diffs of what would change. One click remediates the drifted minions.
- **Patches:** pending package upgrades across the fleet, by package or by minion, showing installed → available versions. Upgrades one package where it's pending, or everything on a minion.
- **Enrollment:** accept or reject keys after checking fingerprints. Generates bootstrap commands, including **pre-seeded keys**, so a new minion is trusted on first contact.
- **Run:** any execution module against any target type. You see which minions the target matches before you run. Results stream in live, and state output is rendered with diffs. Risky commands on many minions need an explicit confirmation.
- **Orchestrate:** runs `state.orchestrate` files, with dry-run and pillar overrides, and shows step-by-step results with per-minion output.
- **Jobs:** the job cache with full results and *run again*.
- **States & Pillar:** browse `file_roots` / `pillar_roots` with syntax highlighting.
- **Events:** the master event bus, live, with filters. Toasts pop up for failed jobs and for minions waiting for approval.
- **⌘K / Ctrl+K** jumps to any page, minion, saved target or recent command.
- **Permission-aware:** reads your eauth permissions at login and disables what your account can't do. Read-only users get a read-only UI.
- **Demo mode:** a simulated master in the browser, for trying it out.

<table>
  <tr>
    <td><img src="docs/screenshots/enrollment.png" alt="Enrollment" /></td>
    <td><img src="docs/screenshots/minions-dark.png" alt="Dark mode" /></td>
  </tr>
  <tr>
    <td align="center">Enrollment</td>
    <td align="center">Dark mode</td>
  </tr>
</table>

## Try it

**Demo, no Salt needed:**

```bash
npm install
npm run dev
```

Open http://localhost:5173/?demo.

**Full local lab:** a Salt master with salt-api, three minions and the production UI.

```bash
cd lab && docker compose up -d --build
```

Open http://localhost:8080 and sign in:

| User | Password | eauth | Access |
| --- | --- | --- | --- |
| `shaker` | `shaker` | `sharedsecret` | everything |
| `viewer` | `viewer` | `file` | read-only, to see the permission-aware UI |

The minion keys start out pending, so accept them on **Enrollment**. These credentials exist only for the lab.

## Connecting to your master

Salt Shaker needs **Salt 3006 or newer** with salt-api enabled:

```yaml
# /etc/salt/master.d/api.conf
rest_cherrypy:
  port: 8000
  ssl_crt: /etc/pki/tls/certs/salt-api.crt
  ssl_key: /etc/pki/tls/private/salt-api.key

# Salt 3006+ disables all netapi clients by default
netapi_enable_clients: [local, local_async, runner, runner_async, wheel]

external_auth:
  pam:
    saltadmins%:                 # members of the Linux group "saltadmins"
      - '.*'
      - '@wheel'
      - '@runner'
      - '@jobs'
    auditors%:                   # a read-only role
      - test.ping
      - grains.*
      - pkg.list_upgrades
      - pkg.version
      - saltutil.find_job
      - '@runner': [manage.status, cache.grains, jobs.*, pillar.show_pillar]
      - '@wheel': [key.list_all, key.finger, file_roots.*, pillar_roots.*]
```

What the UI calls:

| Client | Functions |
| --- | --- |
| `wheel` | `key.*` (enrollment), `file_roots.*` / `pillar_roots.*` (browsing) |
| `runner` | `manage.status`, `cache.grains` (target preview), `jobs.*`, `pillar.show_pillar`, `salt.cmd test.version` (master version), `state.orchestrate` |
| `local` / `local_async` | everything you run on minions |

## Deploying

The Docker image serves the UI with nginx and proxies `/salt-api/` to salt-api on the same origin, so you don't need CORS:

```bash
docker run -d -p 8080:8080 -e SALT_API_URL=https://salt-master:8000 ghcr.io/pipozzz/salt-shaker:latest
```

| Setting | Where | Default | |
| --- | --- | --- | --- |
| `SALT_API_URL` | container env | `http://salt-master:8000` | salt-api the proxy talks to |
| `VITE_SALT_API_URL` | build time | `/salt-api` | for serving the UI from a different origin than salt-api (then enable CORS on salt-api) |
| `VITE_SOURCE_URL` | build time | this repository | source link shown in the UI; point it at your fork if you modify the code (see [License](#license)) |

Images are published to GHCR from `main` (`:latest`, `:sha-…`) and from version tags (`:1.2.0`, `:1.2`). The proxy streams the event bus (SSE) without buffering. It resolves the salt-api host per request, so the UI starts even while the master is down. It also sets strict security headers (CSP included) and serves `/healthz`.

To serve `dist/` some other way (`npm run build`), proxy `/salt-api/` to salt-api with response buffering turned off.

## Security notes

- Put TLS in front of the UI. The salt-api token is kept in the browser's `localStorage` until it expires or you log out.
- The master enforces permissions. The UI only hides actions your eauth perms wouldn't allow.
- Pre-seeded enrollment shows a minion's private key once. Copy it over a trusted channel.

To report a vulnerability, use GitHub's private [security advisories](https://github.com/pipozzz/salt-shaker/security/advisories/new) rather than a public issue.

## Development

```bash
npm run dev         # dev server; proxies /salt-api to $SALT_API_URL (default http://localhost:8000)
npm test            # unit tests (vitest)
npm run lint        # oxlint
npm run typecheck
npm run build
```

The project is React 19, Vite, TypeScript and Tailwind CSS 4, with no state or data-fetching libraries.

- `src/api/`: the salt-api client (`salt.ts`), the HTTP and SSE transport, and the in-browser mock master used by demo mode.
- `src/pages/`: one file per page.
- `src/components/`: shared UI.
- `src/lib/`: session, permissions, job tracking and risk rules.

A few salt-api behaviours (seen on Salt 3007) that the client handles, in case they save you time too:

- `/events` rejects `?token=`, so the UI reads the SSE stream with `fetch` and an `X-Auth-Token` header.
- `jobs.lookup_jid` wraps state returns in `{outputter, data}`. Runner jobs come back under `<master>_master`.
- jids use the master's local time. The UI learns the offset from wheel replies (`_stamp` is UTC).
- `key.gen_accept` replies `success: true` with an empty dict when the key already exists.
- Offline minions are detected the way the CLI does it: `saltutil.find_job` with a short `gather_job_timeout`.

CI runs lint, typecheck, tests and build on every push and PR. It then builds the Docker image and smoke-tests it.

## License

[GNU Affero General Public License v3.0 or later](LICENSE).

If you run a modified version for others over a network, the AGPL requires you to offer them its source. The UI links to the source in the sidebar and on the login page; set `VITE_SOURCE_URL` to your fork.
