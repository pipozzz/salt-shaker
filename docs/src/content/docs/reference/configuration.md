---
title: Configuration
description: Environment variables of the Salt Shaker server.
---

The server is configured with environment variables.

| Variable | Default | |
| --- | --- | --- |
| `SALT_API_URL` | *(required)* | salt-api (`rest_cherrypy`) base URL |
| `SALT_API_USERNAME` / `SALT_API_PASSWORD` | *(required)* | the service account |
| `SALT_API_EAUTH` | `pam` | eauth backend of the service account |
| `SALT_API_TIMEOUT` | `120` | seconds one call to salt-api may take before it's given up on (answered with a 504), so a stuck master doesn't hold requests forever |
| `SALT_API_CONCURRENCY` | `8` | calls made to salt-api for users at once; more wait in line. Keep it well under salt-api's `thread_pool` |
| `SALT_API_BACKGROUND_CONCURRENCY` | `2` | the same for schedules, presence checks, runbooks and changes, which wait in a line of their own and never take a user's turn |
| `SALT_MASTER` | the host of `SALT_API_URL` | the master's address minions connect to (ports 4505 and 4506), put in the bootstrap command on **Enrollment**; set it when salt-api is reached under another name, or on `127.0.0.1` |
| `PUBLIC_URL` | `http://localhost:8080` | the URL users open; cookies and origin checks are based on it |
| `INSTANCE_NAME` | the host of `PUBLIC_URL` | this instance's name among [several masters](/salt-shaker/deploy/masters/), e.g. `prod-eu` |
| `PORT` | `8080` | port the server listens on |
| `DATABASE_URL` | SQLite in `DATA_DIR` | set `postgres://user:pass@host/db` to use Postgres |
| `ROLE` | `all` | what this instance does: `web` serves the UI and API, `worker` does the background work (job history, schedules, runbooks, presence, the vulnerability report), `all` both. See [Web and worker](/salt-shaker/deploy/docker/#web-and-worker) |
| `DATA_DIR` | `/data` in the image | SQLite database and the generated auth secret |
| `BETTER_AUTH_SECRET` | generated into `DATA_DIR` | set it explicitly when running on Postgres without a data volume |
| `TRUSTED_ORIGINS` | | extra origins allowed to call the API (comma-separated) |
| `TRUST_PROXY` | off | set to `1` behind a reverse proxy, so client IPs (for rate limits and the audit log) are taken from `X-Forwarded-For` |
| `JOB_RETENTION_DAYS` | `90` | how long recorded jobs and their returns are kept |
| `AUDIT_RETENTION_DAYS` | forever | how long [audit log](/salt-shaker/guide/users-audit/#audit-log) entries are kept, e.g. `365`; unset or `0` keeps them all |
| `APPROVAL_REQUIRED` | `off` | `risky`: an operator's command that changes minions becomes a [change](/salt-shaker/guide/changes/) an admin approves before it runs |
| `SMTP_URL` | off | SMTP server for [email notifications](/salt-shaker/guide/schedules/#email), e.g. `smtp://user:pass@smtp.example.com:587` |
| `SMTP_FROM` | `Salt Shaker <salt-shaker@…>` | the sender of those emails; defaults to the host of `PUBLIC_URL` |
| `SLACK_SIGNING_SECRET` | off | the Slack app's signing secret, for the [/salt command](/salt-shaker/guide/slack/) |
| `PRESENCE_CHECK_MINUTES` | `5` | how often the server checks which minions respond, for the *Minions down* alert and the last-answered dates behind *Quiet for a while* on the Keys page, and for who shows as down on Minions, Map and Overview; `0` turns the alert and the dates off, and who responds is then checked every 5 minutes |
| `TZ` | `UTC` in the image | time zone for [schedules](/salt-shaker/guide/schedules/) and the [weekly report](/salt-shaker/guide/schedules/#weekly-report), e.g. `Europe/Bratislava` |
| `PASSWORD_LOGIN` | `all` | `admins` allows passwords for admins only, as a break-glass next to [SSO](/salt-shaker/deploy/sso/) |
| `OSV_API_URL` | `https://api.osv.dev` | where the [vulnerability check](/salt-shaker/guide/vulnerabilities/) asks about packages; another server with the OSV API works too |
| `METRICS_TOKEN` | off | bearer token for the Prometheus endpoint `/metrics`, see [Monitoring](/salt-shaker/deploy/monitoring/) |
| `STATIC_DIR` | `./dist` | where the built UI is served from |

Single sign-on adds the `OIDC_*` variables, listed in [Single sign-on](/salt-shaker/deploy/sso/).

## Build-time variables

These apply when building the UI yourself.

| Variable | |
| --- | --- |
| `VITE_SALT_API_URL` | salt-api URL for [direct mode](/salt-shaker/deploy/direct-mode/) when it's on another origin |
| `VITE_SOURCE_URL` | link to the source code shown in the UI; set it to your fork (see [License](/salt-shaker/reference/security/#license)) |
