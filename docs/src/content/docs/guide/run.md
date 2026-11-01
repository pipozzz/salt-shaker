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

## Orchestrate

**Orchestrate** runs `state.orchestrate` files, with dry-run and pillar overrides. Results are shown step by step, with per-minion output.
