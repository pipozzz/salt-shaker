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

[`deploy/compose.yml`](https://github.com/pipozzz/salt-shaker/blob/main/deploy/compose.yml) runs Salt Shaker behind [Caddy](https://caddyserver.com), which gets a Let's Encrypt certificate for your domain. DNS for the domain must point at the host, and ports 80 and 443 must be open.

```yaml
# compose.yml
services:
  salt-shaker:
    image: ghcr.io/pipozzz/salt-shaker:latest
    restart: unless-stopped
    volumes: [salt-shaker-data:/data]
    environment:
      SALT_API_URL: ${SALT_API_URL}
      SALT_API_USERNAME: ${SALT_API_USERNAME:-salt-shaker}
      SALT_API_PASSWORD: ${SALT_API_PASSWORD}
      SALT_API_EAUTH: ${SALT_API_EAUTH:-sharedsecret}
      PUBLIC_URL: https://${DOMAIN}
      TRUST_PROXY: "1"

  caddy:
    image: caddy:2
    restart: unless-stopped
    ports: ["80:80", "443:443"]
    command: caddy reverse-proxy --from ${DOMAIN} --to salt-shaker:8080
    volumes: [caddy-data:/data]
    depends_on: [salt-shaker]

volumes:
  salt-shaker-data:
  caddy-data:
```

Settings go in `.env` next to it, readable only by root:

```bash
# .env
DOMAIN=salt.example.com
SALT_API_URL=https://salt-master:8000
SALT_API_USERNAME=salt-shaker
SALT_API_EAUTH=sharedsecret
SALT_API_PASSWORD=<the shared secret>
```

```bash
chmod 600 .env
docker compose up -d
```

Open `https://salt.example.com` and create the admin account.

If you already run a reverse proxy, drop the `caddy` service and publish `127.0.0.1:8080:8080` on `salt-shaker` instead. See [Behind a reverse proxy](/salt-shaker/deploy/reverse-proxy/).

## Database

By default the server keeps a SQLite database in `/data`. To use PostgreSQL, set `DATABASE_URL`:

```bash
-e DATABASE_URL=postgres://salt:…@db.example.com/salt_shaker
```

The schema is migrated on start, for both SQLite and Postgres.

:::note
The auth secret is generated into `/data` on first start. When running on Postgres without a data volume, set `BETTER_AUTH_SECRET` explicitly, or sessions are lost on every restart.
:::

## Compose with Postgres and HTTPS

The repository's [`deploy/`](https://github.com/pipozzz/salt-shaker/tree/main/deploy) directory has a complete setup: Salt Shaker, Postgres, and Caddy with automatic HTTPS.

```bash
cd deploy
cp .env.example .env   # set DOMAIN, the service account, secrets, optional SSO
docker compose up -d
```

Point DNS for your domain at the host first, so Caddy can get the certificate.

## Several instances

Several instances can share one Postgres database. Sessions, history and the audit log are shared, and each scheduled run starts exactly once. One instance, elected through a lease in the database, follows the event bus to record jobs and send event alerts. If it stops, another one takes over within about 30 seconds.

## Health check

The container serves `GET /healthz`, which answers `ok`.
