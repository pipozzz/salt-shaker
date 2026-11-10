# Salt Shaker

[![CI](https://github.com/pipozzz/salt-shaker/actions/workflows/ci.yml/badge.svg)](https://github.com/pipozzz/salt-shaker/actions/workflows/ci.yml)
[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue.svg)](LICENSE)

A web UI for [SaltStack](https://saltproject.io) that works with your master through **salt-api** (`rest_cherrypy`). It ships as one container with its own users, roles and audit log. It can also run as a plain static app that signs in to salt-api directly. Try it in your browser without a Salt master.

**Documentation:** https://pipozzz.github.io/salt-shaker/

![Minions overview](docs/screenshots/minions.png)

## Features

- **Minions:** status, OS, IPs, CPU/RAM and roles at a glance, read from the master's cache, so it stays fast with large fleets and shows offline minions too. A fleet breakdown flags minions running an older Salt than the master. Each minion's page shows its grains and compiled pillar.
- **Compliance:** dry-runs the highstate (`test=True`) across a target, then groups minions into *in compliance*, *drifted*, *errors* and *no return*, with diffs of what would change. One click remediates the drifted minions. Past checks are kept, so you can follow drift over time.
- **Patches:** pending package upgrades across the fleet, by package or by minion, showing installed → available versions. Upgrades one package where it's pending, or everything on a minion.
- **Vulnerabilities:** known CVEs in the installed packages, from the distributions' security trackers via OSV.dev, with the fixed version and a one-click upgrade.
- **Enrollment:** accept or reject keys after checking fingerprints. Generates bootstrap commands, including **pre-seeded keys**, so a new minion is trusted on first contact.
- **Run:** any execution module against any target type. You see which minions the target matches before you run. Results stream in live, and state output is rendered with diffs. Risky commands on many minions need an explicit confirmation.
- **Query:** ask minions questions in SQL with osquery (ports, users, SSH keys, processes…) and get one table across the fleet, with a library of ready-made queries, team-saved queries and CSV export. Installs osquery where it's missing.
- **Orchestrate:** runs `state.orchestrate` files, with dry-run and pillar overrides, and shows step-by-step results with per-minion output.
- **Jobs:** full results and *run again*. With the server, jobs are recorded from the event bus and kept for 90 days by default (the master keeps them about 24 hours). That includes jobs run from the salt CLI, along with who ran them.
- **States & Pillar:** browse `file_roots` / `pillar_roots` with syntax highlighting.
- **Events:** the master event bus, live, with filters. Toasts pop up for failed jobs and for minions waiting for approval.
- **Users & roles:** *admin*, *operator* and *viewer* accounts, managed in the UI. No Linux accounts are needed on the master.
- **Single sign-on:** OIDC with Keycloak, Entra ID, Google, Authentik, Okta and others. Roles can come from IdP groups and are refreshed on every sign-in.
- **Schedules:** nightly compliance checks, weekly patch or vulnerability scans or any function, on a cron schedule.
- **Notifications:** Slack-format, Microsoft Teams or JSON webhooks for drift, available upgrades, failed jobs and minions waiting for approval.
- **Audit log:** every change, plus every denied attempt, with who, what, where and the resulting jid. Salt's job cache records the user too.
- **⌘K / Ctrl+K** jumps to any page, minion, saved target or recent command.
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

**Full local lab:** a Salt master with salt-api, three minions and the Salt Shaker container.

```bash
cd lab && docker compose up -d --build
```

Open http://localhost:8080. The first visit asks you to create the admin account. The minion keys start out pending, so accept them on **Enrollment**.

The lab also runs a mock OIDC provider. Click **Sign in with Lab SSO**, type any username and add claims such as `{"groups": ["salt-operators"]}` (or `salt-admins` / `salt-viewers`). Without one of those groups, the sign-in is refused.

## How it works

```
browser ──cookie session──▶ Salt Shaker server ──service account──▶ salt-api ──▶ master
                              users · roles · audit
                              SQLite or Postgres
```

The server signs in to salt-api with **one service account**. It also listens to the master's event bus and records every job and its returns, including jobs it didn't start, to keep history beyond the master's job cache. Every request from a user is checked against their role first, then passed on. The user's own credentials and token never reach salt-api. Local jobs get the user's name in their job metadata (`salt_shaker_user`), so `jobs.list_job` shows who ran them.

| Role | Can do |
| --- | --- |
| **admin** | Everything, including accepting keys and managing users. |
| **operator** | Runs anything on minions (states, commands, packages, orchestration). Can't manage keys, users or files on the master. |
| **viewer** | Read-only. Sees minions, jobs and states, but not pillar data, which often holds secrets. |
| **none** | Can't sign in. Use it to switch off an account, or for SSO users who haven't been granted a role yet. |

Roles are written in Salt's eauth format (`server/roles.ts`). The UI and the server read the same rules.

## Deploying

```bash
docker run -d --name salt-shaker -p 8080:8080 -v salt-shaker-data:/data \
  -e SALT_API_URL=https://salt-master:8000 \
  -e SALT_API_USERNAME=salt-shaker -e SALT_API_PASSWORD=… -e SALT_API_EAUTH=sharedsecret \
  -e PUBLIC_URL=https://salt.example.com \
  ghcr.io/pipozzz/salt-shaker:latest
```

Then open the URL and create the admin.

For a complete setup with automatic HTTPS (Caddy), use [`deploy/`](deploy): copy `deploy/.env.example` to `deploy/.env` and fill it in. Then run `docker compose -f docker-compose.sqlite.yml up -d` there for SQLite, or `docker compose up -d` for Postgres.

| Variable | Default | |
| --- | --- | --- |
| `SALT_API_URL` | *(required)* | salt-api (`rest_cherrypy`) base URL |
| `SALT_API_USERNAME` / `SALT_API_PASSWORD` | *(required)* | the service account |
| `SALT_API_EAUTH` | `pam` | eauth backend of the service account |
| `PUBLIC_URL` | `http://localhost:8080` | the URL users open; cookies and origin checks are based on it |
| `DATABASE_URL` | SQLite in `DATA_DIR` | set `postgres://user:pass@host/db` to use Postgres |
| `DATA_DIR` | `/data` | SQLite database and the generated auth secret |
| `BETTER_AUTH_SECRET` | generated into `DATA_DIR` | set it explicitly when running on Postgres without a data volume |
| `TRUSTED_ORIGINS` | | extra origins allowed to call the API (comma-separated) |
| `TRUST_PROXY` | off | set to `1` behind a reverse proxy, so client IPs (for rate limits and the audit log) are taken from `X-Forwarded-For` |
| `JOB_RETENTION_DAYS` | `90` | how long recorded jobs and their returns are kept |
| `PRESENCE_CHECK_MINUTES` | `5` | how often the server checks which minions respond, for the *Minions down* alert; `0` turns it off |
| `TZ` | `UTC` in the image | time zone for schedules, e.g. `Europe/Bratislava` |

The database schema is migrated on start, for both SQLite and Postgres.

Several instances can share one Postgres database: sessions, history and the audit log are shared, each scheduled run starts exactly once, and one instance (elected through a lease in the database) follows the event bus to record jobs and send event alerts. If it stops, another one takes over within about 30 seconds.

Put TLS in front, for example with a load balancer, Traefik or nginx. If you proxy it yourself, turn off response buffering for `/api/salt/events` (Server-Sent Events). The container serves `/healthz`, and with `METRICS_TOKEN` set, Prometheus metrics at `/metrics` ([Monitoring](https://pipozzz.github.io/salt-shaker/deploy/monitoring/)).

Images for `linux/amd64` and `linux/arm64` are published to GHCR from `main` (`:latest`, `:sha-…`) and from version tags (`:1.2.0`, `:1.2`).

### Single sign-on (OIDC)

Register Salt Shaker as a confidential client with the redirect URI `<PUBLIC_URL>/api/auth/callback/oidc`, then set:

| Variable | |
| --- | --- |
| `OIDC_ISSUER` | issuer URL; discovery is read from `/.well-known/openid-configuration` |
| `OIDC_CLIENT_ID` / `OIDC_CLIENT_SECRET` | the client credentials |
| `OIDC_NAME` | button label, e.g. `Keycloak` (default `SSO`) |
| `OIDC_SCOPES` | default `openid,profile,email`; add `groups` if your IdP needs it |
| `OIDC_ROLE_CLAIM` | claim holding groups or roles, e.g. `groups` or `realm_access.roles`. When set, the IdP decides each user's role on every sign-in. |
| `OIDC_ADMIN_GROUPS` / `OIDC_OPERATOR_GROUPS` / `OIDC_VIEWER_GROUPS` | comma-separated values of that claim per role; the highest match wins |
| `OIDC_DEFAULT_ROLE` | role when nothing matches: `none` (default with a role claim, so sign-in is refused) or `viewer` (default without one, so admins assign roles in the UI) |
| `PASSWORD_LOGIN` | `all` (default), or `admins`: only admins may use passwords, as a break-glass when the IdP is down |

The flow uses PKCE and checks the `id_token` nonce. If the IdP is unreachable when the server starts, SSO stays off and turns itself on once discovery succeeds.

### The service account on the master

```yaml
# /etc/salt/master.d/api.conf
rest_cherrypy:
  port: 8000
  ssl_crt: /etc/pki/tls/certs/salt-api.crt
  ssl_key: /etc/pki/tls/private/salt-api.key

# Salt 3006+ disables all netapi clients by default
netapi_enable_clients: [local, local_async, runner, runner_async, wheel]

sharedsecret: <a long random string>   # openssl rand -base64 32
external_auth:
  sharedsecret:
    salt-shaker:             # SALT_API_USERNAME; SALT_API_PASSWORD is the shared secret
      - '.*'
      - '@wheel'
      - '@runner'
      - '@jobs'
```

No Linux account is needed. Any other eauth backend (`pam`, `file`, `ldap`) works too; see the [docs](https://pipozzz.github.io/salt-shaker/deploy/master/). Salt Shaker needs **Salt 3006 or newer**. The service account is as powerful as the most powerful role you hand out, so keep its password in a secret store.

### Without the server (direct mode)

The UI also runs as static files that sign in to salt-api directly, with each user's own eauth credentials and permissions. To do that, serve `dist/` (`npm run build`) and proxy `/salt-api/` to salt-api with response buffering off. If the UI and salt-api are on different origins, build with `VITE_SALT_API_URL=https://master:8000` and enable CORS on salt-api. The UI finds out at startup whether a server is present. Users, roles and the audit log are only available with the server.

## Security notes

- Sessions are httpOnly cookies, valid for 12 hours and extended while in use. Cross-origin state-changing requests are refused.
- Passwords must be at least 10 characters. Better Auth rate-limits sign-in attempts. Self-registration is off; only admins create accounts.
- The UI hides what a role can't do, and the server enforces it. Denied attempts are recorded in the audit log.
- Pre-seeded enrollment shows a minion's private key once. Copy it over a trusted channel.

To report a vulnerability, use GitHub's private [security advisories](https://github.com/pipozzz/salt-shaker/security/advisories/new) rather than a public issue.

## Development

```bash
cp .env.example .env    # points at the lab's salt-api
cd lab && docker compose up -d master web-01 web-02 db-01 && cd ..
npm run dev:server      # API on :3100
npm run dev             # UI on :5173, proxies /api to the server
```

| Command | |
| --- | --- |
| `npm test` | unit tests (vitest) |
| `npm run test:e2e` | browser tests (Playwright) against the demo; run `npx playwright install chromium` once first |
| `npm run lint` / `npm run typecheck` | oxlint / TypeScript |
| `npm run build` / `npm run build:server` | UI → `dist/`, server bundle → `dist-server/` |
| `npm run db:generate` | after changing `server/db/schema.*.ts` (keep the SQLite and Postgres schemas in sync), generates migrations for both |

The stack is React 19, Vite, TypeScript and Tailwind CSS 4 on the front end, and Hono, Better Auth and Drizzle on the server.

- `src/api/`: salt-api client, the transports (server, direct, demo mock) and SSE.
- `src/pages/`, `src/components/`: the UI.
- `src/lib/`: session, permissions, job tracking and risk rules.
- `server/`: config, auth, request policy (`policy.ts`), roles, the salt-api service client and the database.

A few salt-api behaviours (seen on Salt 3007) that the client handles, in case they save you time too:

- `/events` rejects `?token=`, so the UI reads the SSE stream with `fetch` and an `X-Auth-Token` header.
- `jobs.lookup_jid` wraps state returns in `{outputter, data}`. Runner jobs come back under `<master>_master`.
- jids use the master's local time. The UI learns the offset from wheel replies (`_stamp` is UTC).
- `key.gen_accept` replies `success: true` with an empty dict when the key already exists.
- Offline minions are detected the way the CLI does it: `saltutil.find_job` with a short `gather_job_timeout`.

CI runs lint (no warnings allowed), typecheck, unit tests, browser tests and the build on every push and PR. It then builds the Docker image and smoke-tests it. Dependabot proposes dependency updates weekly.

## License

[GNU Affero General Public License v3.0 or later](LICENSE).

If you run a modified version for others over a network, the AGPL requires you to offer them its source. The UI links to the source in the sidebar and on the login page; set `VITE_SOURCE_URL` to your fork.
