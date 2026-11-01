---
title: Users & Audit log
description: Manage accounts and review who did what.
sidebar: { order: 7 }
---

## Users

Admins create and manage accounts on the **Users** page. Each account has one [role](/salt-shaker/reference/roles/): *admin*, *operator* or *viewer*. No Linux accounts are needed on the master.

The first admin is created on the first visit to a fresh install.

## Audit log

The **Audit log** records every change, plus every denied attempt, with who, what, where (client IP) and the resulting jid.

Salt's own job cache records the user too, in the job metadata as `salt_shaker_user`.
