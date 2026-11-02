---
title: Run the container
description: Deploy Salt Shaker as a single Docker container.
sidebar: { order: 2 }
---

Images for `linux/amd64` and `linux/arm64` are published to GHCR from `main` (`:latest`, `:sha-…`) and from version tags (`:1.2.0`, `:1.2`).

```bash
docker run -d --name salt-shaker -p 8080:8080 -v salt-shaker-data:/data \
  -e SALT_API_URL=https://salt-master:8000 \
  -e SALT_API_USERNAME=salt-shaker -e SALT_API_PASSWORD=… -e SALT_API_EAUTH=sharedsecret \
  -e PUBLIC_URL=https://salt.example.com \
  ghcr.io/pipozzz/salt-shaker:latest
```

`SALT_API_PASSWORD` is the shared secret, or the account's password with another eauth backend. See [Prepare the master](/salt-shaker/deploy/master/).

Then open the URL and create the admin account. Self-registration is off; after this, only admins create accounts.

All settings are environment variables, listed in [Configuration](/salt-shaker/reference/configuration/).

## With Docker Compose

[`deploy/`](https://github.com/pipozzz/salt-shaker/tree/main/deploy) has two production setups. Both run behind [Caddy](https://caddyserver.com), which gets a Let's Encrypt certificate for your domain, and share one `.env`.

| | File | Use it for |
| --- | --- | --- |
| **SQLite** | `docker-compose.sqlite.yml` | one instance; the simplest setup, with everything in one volume |
| **Postgres** | `docker-compose.yml` | [several instances](#several-instances), or when you already run and back up Postgres |

DNS for the domain must point at the host, and ports 80 and 443 must be open.

```bash
git clone https://github.com/pipozzz/salt-shaker.git
cd salt-shaker/deploy
cp .env.example .env && chmod 600 .env
```

Fill in `.env`:

```bash
DOMAIN=salt.example.com
SALT_API_URL=https://salt-master.internal:8000
SALT_API_USERNAME=salt-shaker
SALT_API_PASSWORD=<the shared secret>
SALT_API_EAUTH=sharedsecret

# Postgres only; generate with: openssl rand -base64 32
POSTGRES_PASSWORD=
BETTER_AUTH_SECRET=

# pin a release instead of following latest
SALT_SHAKER_VERSION=latest
```

The `OIDC_*` settings are optional; leave `OIDC_ISSUER` empty to use local accounts only.

### SQLite

```bash
docker compose -f docker-compose.sqlite.yml up -d
```

The database and the generated auth secret are kept in the `data` volume. Back it up; losing the auth secret signs everyone out.

### Postgres

Set `POSTGRES_PASSWORD` and `BETTER_AUTH_SECRET` in `.env`, then:

```bash
docker compose up -d
```

### Then

Open `https://salt.example.com` and create the admin account.

If you already run a reverse proxy, drop the `caddy` service, publish `127.0.0.1:8080:8080` on `salt-shaker` and see [Behind a reverse proxy](/salt-shaker/deploy/reverse-proxy/).

## Database

By default the server keeps a SQLite database in `/data`. To use PostgreSQL, set `DATABASE_URL`:

```bash
-e DATABASE_URL=postgres://salt:…@db.example.com/salt_shaker
```

The schema is migrated on start, for both SQLite and Postgres.

:::note
The auth secret is generated into `/data` on first start. When running on Postgres without a data volume, set `BETTER_AUTH_SECRET` explicitly, or sessions are lost on every restart.
:::

## Several instances

Several instances can share one Postgres database. Sessions, history and the audit log are shared, and each scheduled run starts exactly once. One instance, elected through a lease in the database, follows the event bus to record jobs and send event alerts. If it stops, another one takes over within about 30 seconds.

## Health check

The container serves `GET /healthz`, which answers `ok`. For Prometheus metrics, see [Monitoring](/salt-shaker/deploy/monitoring/).
