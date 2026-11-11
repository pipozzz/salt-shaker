---
title: Changes
description: Roll a command out in batches, stop on failures, and approve risky ones first.
sidebar: { order: 6 }
---

A **change** runs one command on a target a few minions at a time, and stops when too many fail. With the approval policy on, an operator's change that touches minions waits for an admin to approve it first.

## Rolling out in batches

On [Run](/salt-shaker/guide/run/), tick **Roll out in batches**, then:

- **Batch size**: how many minions at a time, as a number (`5`) or a share (`25%`).
- **Failures allowed**: it stops once more minions than this have failed. `0` stops at the first failure.
- **Why**: kept with the change, and shown to whoever approves it.

**Start rollout** creates the change and opens it. The server works out the minions the target matches, starts the first batch, and starts the next one when every minion of the last has returned. A minion that returns an error counts as failed, and so does one that hasn't answered within 15 minutes. Each batch is an ordinary job, in the history under the requester's name.

The change's page shows its batches with links to their jobs, and every minion as *ok*, *failed*, *running* or *waiting*. **Stop** keeps it from starting more batches (the requester or an admin can); a batch that's running finishes.

## Approvals

With `APPROVAL_REQUIRED=risky` in the [configuration](/salt-shaker/reference/configuration/), an operator can't run a command that changes minions directly (states that aren't dry runs, `cmd.*`, package and service changes, reboots…). On Run, the button says **Request approval**: it creates a change that waits. Calling salt-api through Salt Shaker any other way is refused the same way.

An admin other than the requester opens it from **Changes** (or the [overview](/salt-shaker/guide/overview/)) and **Approves** it, which starts it, or **Rejects** it with a reason. The **Approvals** notification tells admins when one waits; **Changes** tells when a rollout finished, stopped or couldn't start. Requests, decisions and stops are in the [audit log](/salt-shaker/guide/users-audit/#audit-log).

Admins' own commands don't need approval. A limited operator's change is checked against [what they can run on](/salt-shaker/reference/roles/#limiting-what-someone-can-run-on) when they request it and again when it starts.
