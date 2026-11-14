---
title: Minions
description: Every minion's status, grains and pillar.
sidebar: { order: 1 }
---

![Minions](../../../../screenshots/minions.png)

The **Minions** page shows status, OS, IPs, CPU/RAM and roles of every minion. A fleet breakdown flags minions running an older Salt than the master.

With the server, a **Compliance** column shows each minion's result in the latest compliance check it answered: in compliance, drifted or error. It links to that check's job, and the tooltip says when it ran. Minions that no recent check reached show *not checked*. Both checks from the Compliance page and dry-run highstates started elsewhere count. An **Updates** column shows how many package upgrades each minion had in the latest patch scan it answered (`pkg.list_upgrades`, from the Patches page or a schedule), linked to that scan. A scan that failed on a minion doesn't count, so its last good result stays. The **Drifted** filter shows only the minions that drifted or failed in their latest check. Once there is a package scan, a **Vulnerabilities** column shows each minion's known vulnerabilities by severity and links to its list.

The search, the status filter and the fleet breakdown pick are kept in the page's address, so they're still there when you come back from a minion, and you can bookmark or share a filtered list, e.g. `/?status=drifted&facet=role:web`.

To run something on a handful of minions, tick them in the first column (the header box picks every minion the filter shows) and click **Run on selected**. The selection stays while you change the search, so you can pick from several, and Run opens with them as a list target. The bar at the bottom says how many are picked and how many the current filter hides.

**Save as target…** names what the list shows, so Run, schedules and the other pages that take a target can use it (it's added to the saved targets there, shared with the team when there's a server). A pick from the fleet breakdown saves as the grains it stands for, `roles:web` or `G@os:Ubuntu and G@osrelease:24.04`, so minions that match later count too; you can also save just the minions shown, as a list. The search and Up / Down / Drifted change from moment to moment and aren't a target Salt can read, so a list filtered by them saves as the minions it shows. A grain with a space in it can't be part of a target either, and a list longer than 2000 characters can't be saved; narrow it down.

The **saved target** picker next to the search shows only the minions a saved target matches, worked out from the master's cache like the Run page's preview, so nothing runs. It's kept in the address as `?target=<name>`, and works with the other filters: picking a role on top of it and saving again joins them, `web-* and G@roles:web`. **Run on it** opens Run with that target.

**Export CSV** downloads the minions the search and filters match, all of them, not just the 100 on screen, as an inventory spreadsheet: status, OS and release, kernel, IPs, CPUs, memory, virtualization, roles and Salt version. With the server it also has each minion's latest compliance result, pending package upgrades and known [vulnerabilities](/salt-shaker/guide/vulnerabilities/), with when they were checked. Minions whose grains aren't cached yet have empty columns.

## Notes

A **note** on a minion tells the team what its grains can't: who owns it, what it's for, what not to do to it (*Restart only in the Tuesday window*, *Powered off on purpose, being replaced*). It shows at the top of the minion's page, and under its name on the Minions list, where the search finds it too. **Export CSV** has it in a `note` column.

Operators and admins write notes with **Add a note** or **Edit note** on the minion's page, up to 2000 characters; clearing it and saving removes it. Viewers read them. Each note says who changed it last and when, and every change is in the [audit log](/salt-shaker/guide/users-audit/) as `minions.note` (or `minions.note_removed`) with the minion as its target. Notes need the server (or the demo), and stay when a minion's key is removed, so a minion that comes back has its note.

## Large fleets

The list comes from the master's minion data cache (`cache.grains`), so opening it doesn't start a job on the minions. Offline minions keep their last known OS and IPs. Which minions respond (`manage.status`) is filled in once that check finishes. The table shows 100 minions at a time.

With the server, the fleet is cached for 15 seconds and shared by all users. **Refresh** reads it again. If the master runs with `minion_data_cache: False`, Salt Shaker falls back to asking the minions directly, which is slower.

To try it without a fleet, open the demo with `?demo=large` (606 minions).

## Minion details

Each minion's page shows its grains and compiled pillar. Viewers don't see pillar data, since it often holds secrets.

The **Vulnerabilities** tab lists the known vulnerabilities in the minion's packages from its latest [scan](/salt-shaker/guide/vulnerabilities/), with the installed and the fixed version. The **Packages** tab lists everything installed according to that scan, with each package's version and how many vulnerabilities it has; filter by name or show only the vulnerable ones. On Debian, Ubuntu and Alpine these are source packages, with the installed packages built from them underneath.

The **Jobs** tab lists the recorded jobs that targeted the minion, newest first, with how each one ended on that minion: ok, changed, drift (a dry run that would change something), failed or no return. Jobs started from the salt CLI are included. The list covers the job history retention period (`JOB_RETENTION_DAYS`) and is not available in direct mode.

Offline minions are detected the way the Salt CLI does it, with `saltutil.find_job` and a short `gather_job_timeout`.

Press **⌘K** / **Ctrl+K** anywhere to jump to a page, minion, saved target or recent command.

## Comparing two minions

Select two minions on the list and choose **Compare**, or open **Minions → Compare** and pick them, to see what sets them apart: the grains that differ, from the master's cache (so a minion that's down compares too), and the packages that differ in version or are on only one of them, from their latest [vulnerability scan](/salt-shaker/guide/vulnerabilities/). Grains that always differ between machines, like names, addresses and ids, are set apart until you ask for them. Nothing runs on the minions.

