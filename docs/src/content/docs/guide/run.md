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
- Targets can be saved under a name (the bookmark in the target field) and picked again on Run, Schedules and in ⌘K. With the server they're shared with the whole team: operators and admins save them, everyone sees them, and only whoever saved one (or an admin) can change or remove it. Viewers' targets stay in their browser. Targets saved in a browser before the server shared them show a dashed outline and a **Share with the team** button.
- When some minions fail or don't return, **Retry failed** fills the form in again with just those minions (a list target) and the same function and arguments. Nothing runs until you start it.
- Results can be downloaded as CSV (one row per minion, with state counts) or JSON.
- When several minions return the same thing, **By output** groups them: one entry per distinct output with the minions that returned it, biggest group first. Handy for `pkg.version openssl` or `cmd.run 'uname -r'` across a fleet, to spot the few that differ. Each group can be copied as a list of minion IDs, and **Run on these** (if you may run the function) fills in Run with that group as a list target, e.g. to upgrade the minions still on an old version. State runs keep their per-minion view.
- Admins can turn what's in the form into a [schedule](/salt-shaker/guide/schedules/) with **Schedule…**: it opens a new schedule with the function, arguments and target filled in.

## Orchestrate

**Orchestrate** runs `state.orchestrate` files, with dry-run and pillar overrides. Results are shown step by step, with per-minion output.
