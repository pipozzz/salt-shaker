---
title: Several masters
description: One Salt Shaker per master, linked so you see them all and switch between them.
sidebar: { order: 7 }
---

With several Salt masters (regions, environments, customers), run one Salt Shaker per master and link them. Each keeps its own users, roles, history and audit log, so a team can be given one master and not the others, and nothing changes in how any of them works.

## Linking them

1. Give each instance a name with `INSTANCE_NAME` (e.g. `prod-eu`, `prod-us`, `lab`). Without it, the host name of `PUBLIC_URL` is used.
2. On each other instance, make an [API token](/salt-shaker/reference/api/) for a **viewer** user: it only reads that instance's summary.
3. On **System → Other masters**, add each instance with its name, address and token. Salt Shaker reads the instance once before keeping it, so a wrong address or token shows right away.

Do the same on the others if you want the view from each of them. Adding and removing instances is audited.

## What you get

- **All masters** at the top of the overview: every instance side by side, this one first, with its minions, how many don't answer, failed jobs in the last 24 hours, critical vulnerabilities, pending keys and changes awaiting approval. An instance that doesn't answer (or whose token was revoked) says so. The numbers are read when the page loads and kept for 30 seconds.
- A **switcher** at the top of the sidebar, with this instance's name, that opens another instance. You sign in there as usual.

Each instance sums itself up at `GET /api/summary`, which any signed-in user or API token can read; the tokens of the other instances are kept in the database and never shown again.

## Or one Salt Shaker for a syndic

If your masters already report to a master of masters ([Salt syndic](https://docs.saltproject.io/en/latest/topics/topology/syndic.html)), one Salt Shaker connected to the top master sees and targets every minion. Keys and the minion data cache stay with each master, though, so key management and everything read from the cached grains (Minions, Map, target previews) cover only the top master's own minions. Linked instances don't have that limit.
