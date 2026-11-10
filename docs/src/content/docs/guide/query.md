---
title: Query
description: Ask minions questions in SQL with osquery.
sidebar: { order: 6 }
---

**Query** runs an [osquery](https://osquery.io) SQL query on a target and shows the answers of every minion as one table, with a `minion` column first. Ask about listening ports, users, SSH keys, processes, kernel modules, packages, files and [much more](https://osquery.io/schema/).

## Running a query

Pick a target, write a query or choose one from the **Library**, and **Run query** (or press ⌘/Ctrl + Enter). Filter the rows as they come in, and **Export CSV** downloads the rows the filter shows.

Only one `SELECT` (or `WITH … SELECT`) runs at a time, and nothing on the minion changes. Each minion runs `osqueryi --json` through `cmd.run`, with the query on standard input, so it needs permission for `cmd.run`; viewers can't run queries. Every query is in the [audit log](/guide/users-audit/#audit-log) and the job history like any other call.

The library has ready-made queries for listening ports, logged-in users, accounts with a login shell, authorized SSH keys, SUID binaries, cron jobs, kernel modules, the processes using the most memory, and the OS with its uptime.

## Saved queries

With the server, operators and admins save a query for the team with **Save for the team**. Saved queries are listed at the top of the library for everyone; whoever saved one (or an admin) can replace it by saving under the same name, or remove it.

## Installing osquery

Minions without osquery are listed under the results. **Install osquery…** adds the official osquery repository (`pkg.osquery.io`, signed with its own key) and installs the `osquery` package with apt (Debian, Ubuntu) or dnf/yum (RHEL, AlmaLinux, Rocky Linux). It starts no daemon; queries use the `osqueryi` shell. Alpine and other systems aren't covered.

To install it with your own states instead, add the same repository to your `pkgrepo.managed` states and `pkg.installed: osquery`.
