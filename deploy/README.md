# Deploying with Docker Compose

```bash
cp .env.example .env && chmod 600 .env   # fill in PUBLIC_URL and SALT_API_*
docker compose up -d
```

That runs Salt Shaker alone: SQLite in the `data` volume, plain HTTP on port 8080. Open `PUBLIC_URL` and create the admin account.

Everything else is an add-on file, picked with one line in `.env`:

| `COMPOSE_FILE=` | What runs |
| --- | --- |
| `compose.yml` | Salt Shaker alone, on `LISTEN` (default `8080`) |
| `compose.yml:compose.caddy.yml` | + [Caddy](https://caddyserver.com) with automatic HTTPS for the host in `PUBLIC_URL` |
| `compose.yml:compose.traefik.yml` | behind the Traefik you already run (set `DOMAIN`) |
| `…:compose.postgres.yml` | + Postgres instead of SQLite (set `POSTGRES_PASSWORD`) |

With nginx or another proxy on the same host, keep `compose.yml`, set `LISTEN=127.0.0.1:8080` and `TRUST_PROXY=1`, and see [Behind a reverse proxy](https://pipozzz.github.io/salt-shaker/deploy/reverse-proxy/).

Every setting in `.env` reaches the container, so any variable from the [configuration reference](https://pipozzz.github.io/salt-shaker/reference/configuration/) works there. Upgrade with `docker compose pull && docker compose up -d`. Needs Docker Compose 2.24 or newer.

**Coming from `docker-compose.yml` or `docker-compose.sqlite.yml`?** Add `PUBLIC_URL=https://<your DOMAIN>` to `.env`, and `COMPOSE_FILE=compose.yml:compose.caddy.yml:compose.postgres.yml` (was `docker-compose.yml`) or `COMPOSE_FILE=compose.yml:compose.caddy.yml` (was `docker-compose.sqlite.yml`). Volume names are the same, so data and certificates carry over.
