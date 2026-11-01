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
| `PUBLIC_URL` | `http://localhost:8080` | the URL users open; cookies and origin checks are based on it |
| `PORT` | `8080` | port the server listens on |
| `DATABASE_URL` | SQLite in `DATA_DIR` | set `postgres://user:pass@host/db` to use Postgres |
| `DATA_DIR` | `/data` in the image | SQLite database and the generated auth secret |
| `BETTER_AUTH_SECRET` | generated into `DATA_DIR` | set it explicitly when running on Postgres without a data volume |
| `TRUSTED_ORIGINS` | | extra origins allowed to call the API (comma-separated) |
| `TRUST_PROXY` | off | set to `1` behind a reverse proxy, so client IPs (for rate limits and the audit log) are taken from `X-Forwarded-For` |
| `JOB_RETENTION_DAYS` | `90` | how long recorded jobs and their returns are kept |
| `TZ` | `UTC` in the image | time zone for [schedules](/salt-shaker/guide/schedules/), e.g. `Europe/Bratislava` |
| `PASSWORD_LOGIN` | `all` | `admins` allows passwords for admins only, as a break-glass next to [SSO](/salt-shaker/deploy/sso/) |
| `STATIC_DIR` | `./dist` | where the built UI is served from |

Single sign-on adds the `OIDC_*` variables, listed in [Single sign-on](/salt-shaker/deploy/sso/).

## Build-time variables

These apply when building the UI yourself.

| Variable | |
| --- | --- |
| `VITE_SALT_API_URL` | salt-api URL for [direct mode](/salt-shaker/deploy/direct-mode/) when it's on another origin |
| `VITE_SOURCE_URL` | link to the source code shown in the UI; set it to your fork (see [License](/salt-shaker/reference/security/#license)) |
