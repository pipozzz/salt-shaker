---
title: Jobs & Events
description: Job history, re-runs and the live event bus.
sidebar: { order: 6 }
---

## Jobs

**Jobs** shows full results of past jobs, and can *run again* any of them.

The master keeps jobs for about 24 hours. With the server, jobs are recorded from the event bus and kept for 90 days by default (`JOB_RETENTION_DAYS`). That includes jobs run from the salt CLI, along with who ran them.

## Events

**Events** shows the master's event bus live, with filters. Toasts pop up for failed jobs and for minions waiting for approval.

## States & Pillar

![States](../../../../screenshots/states.png)

Browse `file_roots` and `pillar_roots` with syntax highlighting.
