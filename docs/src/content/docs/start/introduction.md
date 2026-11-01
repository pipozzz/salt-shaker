---
title: Introduction
description: What Salt Shaker is and how it talks to your Salt master.
sidebar: { order: 1 }
---

Salt Shaker is a web UI for [SaltStack](https://saltproject.io). It talks to your master through **salt-api** (`rest_cherrypy`) and needs nothing installed on the minions.

It runs in one of two modes:

- **Server mode** (recommended): one container with the UI and a small server. The server keeps its own users, roles, audit log and job history, and talks to salt-api with a single service account.
- **Direct mode**: the UI as static files that sign in to salt-api with each user's own eauth credentials. No users, roles or audit log. See [Direct mode](/salt-shaker/deploy/direct-mode/).

## How it works

```
browser ──cookie session──▶ Salt Shaker server ──service account──▶ salt-api ──▶ master
                              users · roles · audit
                              SQLite or Postgres
```

The server signs in to salt-api with **one service account**. It also listens to the master's event bus and records every job and its returns, including jobs it didn't start, so history outlives the master's job cache.

Every request from a user is checked against their [role](/salt-shaker/reference/roles/) first, then passed on. The user's own credentials and token never reach salt-api. Local jobs carry the user's name in their job metadata (`salt_shaker_user`), so `jobs.list_job` shows who ran them.

## Requirements

- **Salt 3006 or newer** on the master, with salt-api (`rest_cherrypy`).
- Docker, or Node.js 24 to run the server bundle yourself.
- SQLite (built in) or PostgreSQL for the server's database.
