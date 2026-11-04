---
title: Run & Orchestrate
description: Run execution modules and orchestration files.
sidebar: { order: 5 }
---

## Run

**Run** executes any execution module against any target type (glob, PCRE, list, grain, pillar, compound, nodegroup).

- Before you run, you see which minions the target matches.
- Results stream in live. State output is rendered with diffs.
- Risky commands on many minions need an explicit confirmation.
- Targets can be saved and reused.
- When some minions fail or don't return, **Retry failed** fills the form in again with just those minions (a list target) and the same function and arguments. Nothing runs until you start it.
- Results can be downloaded as CSV (one row per minion, with state counts) or JSON.
- Admins can turn what's in the form into a [schedule](/salt-shaker/guide/schedules/) with **Schedule…**: it opens a new schedule with the function, arguments and target filled in.

## Orchestrate

**Orchestrate** runs `state.orchestrate` files, with dry-run and pillar overrides. Results are shown step by step, with per-minion output.
