---
title: Try it
description: Run Salt Shaker in demo mode or against a local Salt lab.
sidebar: { order: 2 }
---

## Demo mode, no Salt needed

A simulated master runs in the browser.

```bash
npm install
npm run dev
```

Open <http://localhost:5173/?demo>.

## Full local lab

The `lab/` directory has a Docker Compose setup with a Salt master running salt-api, three minions (`web-01`, `web-02`, `db-01`) and the Salt Shaker container.

```bash
cd lab && docker compose up -d --build
```

Open <http://localhost:8080>. The first visit asks you to create the admin account.

The minion keys start out pending, so go to **Enrollment** and accept them. Then you're ready to run commands, check compliance and browse states.

To try the [Query](/salt-shaker/guide/query/) page, run a query: the lab's minions don't have osquery yet, and **Install osquery…** sets it up on them (they need internet access).

The lab also has a mock OIDC provider for trying [single sign-on](/salt-shaker/deploy/sso/#trying-it).
