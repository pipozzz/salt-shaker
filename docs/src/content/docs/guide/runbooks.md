---
title: Runbooks
description: Save a procedure of a few steps once, and let anyone who may run it with their own values.
sidebar: { order: 6 }
---

A **runbook** is a procedure your team repeats, written down once: a few steps, each one function on a target, and the values that change each time. *Restart a service safely* checks the configuration, restarts the service only if the check passed, then makes sure it runs. An operator who doesn't know the Salt functions by heart picks the runbook, fills in the minion and the service, and follows it step by step.

The demo has two to try. Runbooks need the server (or the demo); they aren't there when you sign in to salt-api directly.

## Writing one

Admins write runbooks on **Runbooks → New runbook**:

- **Values to ask for**, each with a name, how it's asked, a default and whether it's required. Use them in a step as `{{name}}`.
- **Steps, in order**: a name, the target and how it matches (glob, list, grain, …), the function and its arguments as on the [Run](/salt-shaker/guide/run/) page, for example `service.restart` with `{{service}}`, or `state.apply` with `test=True`. Up to 20 steps.
- **Go on even if this one fails**, for a step whose failure shouldn't stop the rest, like a dry run.

A value is put *into* an argument, after the arguments are split: a value of `nginx test=True` stays one argument and can't add `test=True` of its own. In a target it's used as typed, and the target is checked against the person's scope like any other.

## Running one

**Run…** asks for the values, starts the run and opens it. Each step:

1. runs **as you**, through the same checks as the Run page: your role, your [scope](/salt-shaker/guide/users-audit/), and the audit log, where every step is a line of its own;
2. waits for its minions to return, for up to 15 minutes; a minion that doesn't return counts as failed;
3. stops the run when it fails on any minion, unless it may fail. The steps after it are skipped.

The run's page shows each step with its minions, which failed and a link to its job, and refreshes while it runs. Whoever started it, or an admin, can **Stop** it: the step that's running finishes, and nothing after it starts. **Recent runs** lists them all; operators and viewers see them too.

Viewers read runbooks and their runs but don't run them.

## Approval

With `APPROVAL_REQUIRED=risky`, an operator's run with a step that changes minions waits for an admin other than them to **Approve** it, like a [change](/salt-shaker/guide/changes/#approvals). Once approved, its steps run without asking again. An admin's own runs start right away.

Notifications have a **Runbook runs** event for runs that finished, stopped or failed, and runs waiting for approval go to **Changes waiting for approval**.

:::note
Runs are kept in the database and worked through by whichever server instance gets to them first, so a run carries on when the instance that started it restarts. A step that was being started at that very moment is marked failed rather than run twice.
:::
