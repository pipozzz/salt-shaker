---
title: Users & Audit log
description: Manage accounts and review who did what.
sidebar: { order: 8 }
---

## Users

Admins create and manage accounts on the **Users** page. Each account has one [role](/salt-shaker/reference/roles/): *admin*, *operator*, *viewer* or *none*. No Linux accounts are needed on the master.

With [single sign-on](/salt-shaker/deploy/sso/), users are created on their first sign-in and marked with the provider's name. They have no password here. When roles come from the provider's groups, they can't be changed on this page.

To stop someone from signing in, give them the *none* role, disable them, or delete them.

The first admin is created on the first visit to a fresh install.

## Audit log

The **Audit log** records every change, plus every denied attempt, with who, what, where (client IP) and the resulting jid.

Salt's own job cache records the user too, in the job metadata as `salt_shaker_user`.
