---
title: Development
description: Run the server and UI locally, and the commands you'll need.
---

```bash
cp .env.example .env    # points at the lab's salt-api
cd lab && docker compose up -d master web-01 web-02 db-01 && cd ..
npm run dev:server      # API on :3100
npm run dev             # UI on :5173, proxies /api to the server
```

| Command | |
| --- | --- |
| `npm test` | unit tests (vitest) |
| `npm run lint` / `npm run typecheck` | oxlint / TypeScript |
| `npm run build` / `npm run build:server` | UI → `dist/`, server bundle → `dist-server/` |
| `npm run db:generate` | after changing `server/db/schema.*.ts` (keep the SQLite and Postgres schemas in sync), generates migrations for both |

The stack is React 19, Vite, TypeScript and Tailwind CSS 4 on the front end, and Hono, Better Auth and Drizzle on the server.

- `src/api/`: salt-api client, the transports (server, direct, demo mock) and SSE.
- `src/pages/`, `src/components/`: the UI.
- `src/lib/`: session, permissions, job tracking and risk rules.
- `server/`: config, auth, request policy (`policy.ts`), roles, the salt-api service client and the database.

## These docs

The docs are an [Astro Starlight](https://starlight.astro.build) site in `docs/`.

```bash
cd docs && npm install && npm run dev
```

## salt-api quirks

A few salt-api behaviours (seen on Salt 3007) that the client handles:

- `/events` rejects `?token=`, so the UI reads the SSE stream with `fetch` and an `X-Auth-Token` header.
- `jobs.lookup_jid` wraps state returns in `{outputter, data}`. Runner jobs come back under `<master>_master`.
- jids use the master's local time. The UI learns the offset from wheel replies (`_stamp` is UTC).
- `key.gen_accept` replies `success: true` with an empty dict when the key already exists.
