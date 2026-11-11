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

[`deploy/`](https://github.com/pipozzz/salt-shaker/tree/main/deploy) starts from a plain `compose.yml`: Salt Shaker alone, with SQLite in a volume and plain HTTP on port 8080. HTTPS and Postgres are add-on files you pick in `.env`. Needs Docker Compose 2.24 or newer.

```bash
git clone https://github.com/pipozzz/salt-shaker.git
cd salt-shaker/deploy
cp .env.example .env && chmod 600 .env
```

Fill in `.env`:

```bash
PUBLIC_URL=http://salt.example.internal:8080
SALT_API_URL=https://salt-master.internal:8000
SALT_API_USERNAME=salt-shaker
SALT_API_PASSWORD=<the shared secret>
SALT_API_EAUTH=sharedsecret
```

Then:

```bash
docker compose up -d
```

Open `PUBLIC_URL` and create the admin account. Then open **System** in the menu: it shows whether salt-api answers the service account, whether the event bus is followed, and the settings the server picked up.

Every setting in `.env` reaches the container, so any variable from [Configuration](/salt-shaker/reference/configuration/) works there, for example `OIDC_*` for [single sign-on](/salt-shaker/deploy/sso/) or `METRICS_TOKEN`. Leave a setting out rather than empty.

### HTTPS, Postgres, Traefik

One line in `.env` picks what runs, as compose files joined with `:`:

| `COMPOSE_FILE=` | What runs |
| --- | --- |
| `compose.yml` | Salt Shaker alone, on `LISTEN` (default `8080`) |
| `compose.yml:compose.caddy.yml` | + [Caddy](https://caddyserver.com), which gets a Let's Encrypt certificate for the host in `PUBLIC_URL` |
| `compose.yml:compose.traefik.yml` | behind the Traefik you already run |
| `compose.yml:compose.caddy.yml:compose.postgres.yml` | + Postgres instead of SQLite |

Run `docker compose up -d` again after changing it.

- **Caddy**: set `PUBLIC_URL=https://salt.example.com`. DNS for the host must point here, with ports 80 and 443 open. Salt Shaker itself is then reachable only through Caddy.
- **Traefik**: set `PUBLIC_URL=https://salt.example.com` and `DOMAIN=salt.example.com`. The container joins the Docker network `traefik` and asks for the entrypoint `websecure` and the certificate resolver `letsencrypt`; set `TRAEFIK_NETWORK`, `TRAEFIK_ENTRYPOINT` or `TRAEFIK_CERTRESOLVER` if yours are named differently.
- **Postgres**: set `POSTGRES_PASSWORD` (for example `openssl rand -hex 24`). For a Postgres you already run, skip `compose.postgres.yml` and set `DATABASE_URL` instead. Use Postgres for [several instances](#several-instances), or when you already back it up.
- **nginx or another proxy on this host**: keep `compose.yml`, set `LISTEN=127.0.0.1:8080` and `TRUST_PROXY=1`, and see [Behind a reverse proxy](/salt-shaker/deploy/reverse-proxy/).

The database (with SQLite) and the generated auth secret are kept in the `data` volume. Back it up; losing the auth secret signs everyone out.

Upgrade with `docker compose pull && docker compose up -d`. To stay on a release, set `SALT_SHAKER_VERSION`, e.g. `1.20.0`.

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

**System** (admins only) checks salt-api with the service account, shows which instance follows the event bus and when it last heard from it, and lists notification channels whose last delivery failed. If the instance holding the event bus lease crashed, it says so and when another one takes over.


The container serves `GET /healthz`, which answers `ok`. For Prometheus metrics, see [Monitoring](/salt-shaker/deploy/monitoring/).
