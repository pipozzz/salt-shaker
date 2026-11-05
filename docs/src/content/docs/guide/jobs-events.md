---
title: Jobs & Events
description: Job history, re-runs and the live event bus.
sidebar: { order: 6 }
---

## Jobs

**Jobs** shows full results of past jobs. From a job you can *run it again*, retry only the minions that failed or didn't return, or download the results as CSV or JSON.

**Running now**, at the top, lists the jobs minions are still working on (`jobs.active`, which asks every minion, so it takes a few seconds). **Stop** ends a job on the minions still running it with `saltutil.kill_job`, after a confirmation. Those minions return no result, and a state run stopped midway may leave some states applied and others not. Viewers see running jobs but can't stop them, and every stop is in the audit log.

A job's own page asks the minions that haven't returned yet whether they're still working on it (`saltutil.find_job`), shows them as *still running* and offers **Stop** there too. The rest are listed as *no return*.

The master keeps jobs for about 24 hours. With the server, jobs are recorded from the event bus and kept for 90 days by default (`JOB_RETENTION_DAYS`). That includes jobs run from the salt CLI, along with who ran them. The **Result** filter keeps jobs where at least one minion failed, or only dry runs (compliance checks and other `test=True` runs). A search stays in the address (`/jobs?q=state.apply&result=failed`), so going back from a job returns to the same list. **Export CSV** downloads every job that matches the current search and result filter, up to 100,000 rows: jid, start time (ISO 8601 UTC), function, arguments as JSON, target, who started it, and how many minions were targeted, returned and failed.

## Events

**Events** shows the master's event bus live, with filters. Toasts pop up for failed jobs and for minions waiting for approval.

## States & Pillar

![States](../../../../screenshots/states.png)

Browse `file_roots` and `pillar_roots` with syntax highlighting.
