---
title: Runbooks
description: Save a procedure of a few steps once, and let anyone who may run it with their own values, on a schedule or from a webhook.
sidebar: { order: 6 }
---

A **runbook** is a procedure your team repeats, written down once: a few steps, each one function on a target, and the values that change each time. *Restart a service safely* checks the configuration, restarts the service only if the check passed, then makes sure it runs. An operator who doesn't know the Salt functions by heart picks the runbook, fills in the minion and the service, and follows it step by step.

The demo has two to try. Runbooks need the server (or the demo); they aren't there when you sign in to salt-api directly.

## Writing one

Admins write runbooks on **Runbooks → New runbook**:

- **Values to ask for**, each with a name, how it's asked, a default and whether it's required. Use them in a step as `{{name}}`.
- **Steps, in order**: a name, the target and how it matches (glob, list, grain, …), the function and its arguments as on the [Run](/salt-shaker/guide/run/) page, for example `service.restart` with `{{service}}`, or `state.apply` with `test=True`. Up to 20 steps.
- **Go on even if this one fails**, for a step whose failure shouldn't stop the rest, like a dry run.
- **Run only if a step before stops the run**, for steps that put things back: start the service again, roll back a release, send an event. They come after the others and are skipped when everything goes well. When a step stops the run, the steps after it are skipped and these run instead, one after another, each even if the one before failed; the run then ends as *stopped* (or *failed*) with that step's error. Stopping a run by hand doesn't run them.

A value is put *into* an argument, after the arguments are split: a value of `nginx test=True` stays one argument and can't add `test=True` of its own. In a target it's used as typed, and the target is checked against the person's scope like any other.

## Running one

**Run…** asks for the values, starts the run and opens it. Each step:

1. runs **as you**, through the same checks as the Run page: your role, your [scope](/salt-shaker/guide/users-audit/), and the audit log, where every step is a line of its own;
2. waits for its minions to return, for up to 15 minutes; a minion that doesn't return counts as failed;
3. stops the run when it fails on any minion, unless it may fail. The steps after it are skipped.

The run's page shows each step with its minions, which failed and a link to its job, and refreshes while it runs. **Output** under a step shows what each minion returned, failures first, as on the job's page; a step that failed shows it right away. Whoever started it, or an admin, can **Stop** it: the step that's running finishes, and nothing after it starts. **Recent runs** lists them all; operators and viewers see them too.

Once a run has ended, **Run again** opens the form with its values, to change what you need. A run that stopped or failed can also **Continue from step N**: a new run, as you, that starts at the step that stopped it and runs it and the rest again, with the same values. The steps before it aren't run again; they show as they ended, with a link to the run they ran in. Its steps for a failure run again only if it fails again. With approval on, it waits for an admin if a step it runs is risky.

Viewers read runbooks and their runs but don't run them.

## Approval

With `APPROVAL_REQUIRED=risky`, an operator's run with a step that changes minions waits for an admin other than them to **Approve** it, like a [change](/salt-shaker/guide/changes/#approvals). Once approved, its steps run without asking again. An admin's own runs start right away.

Notifications have a **Runbook runs** event for runs that finished, stopped or failed, and runs waiting for approval go to **Changes waiting for approval**.

## On a schedule

A [schedule](/salt-shaker/guide/schedules/) can run a runbook: on **Schedules → New schedule**, pick **A runbook** under *What to run*, choose the runbook and fill in its values, which are checked like a run's. *Sync and apply the highstate* on `web-*` every Tuesday at 22:00, inside a [maintenance window](/salt-shaker/guide/schedules/#maintenance-windows), is the demo's.

- A scheduled run acts as the schedule, with an admin's rights like every schedule, so nothing waits for approval. Its steps are in the audit log as `schedule:<name>`.
- A new run starts only once the last one has finished; until then the schedule says it's still going.
- The schedule's summary links to its last run, and its bars to the last ten. How each ended goes to the **Runbook runs** notification.
- With a window, the run *starts* inside it; its steps go on until they're done.
- A runbook a schedule runs can't be deleted until the schedule is deleted or runs another one. Changes to the runbook apply from its next run.

## From a webhook

A **webhook** lets another tool start a runbook: Alertmanager restarting a service that went down, CI applying the highstate after a merge, a ticket system running a fix. Admins add one under **Runbooks → Webhooks → New webhook**:

- the runbook it starts;
- for each of its values, one set here, **The call may set it**, or both (the call's wins, yours is the default). A call can't set anything you didn't allow, and every required value has to be covered one way or the other.

The secret is shown once, when it's made or replaced with **New secret**; the old one stops working right away. A call is a `POST` to the URL shown, with a JSON body:

```sh
curl -X POST https://salt.example.com/api/hooks/runbooks/3 \
  -H "Authorization: Bearer whk_…" \
  -H "Content-Type: application/json" \
  -d '{"host": "web-02"}'
```

The values are read from the top level of the body or from `"params"`, and the rest of the body is ignored, so a tool's own payload can carry them. A call proves it knows the secret either way:

- `Authorization: Bearer <secret>`, for tools that can only add a header;
- or signed like Salt Shaker's own [webhooks](/salt-shaker/guide/schedules/#signed-webhooks): `X-Salt-Shaker-Timestamp` and `X-Salt-Shaker-Signature` (`sha256=` and the HMAC-SHA256 of `<timestamp>.<raw body>`), no more than five minutes old.

It answers `202` with the run (`{"run": 12, "status": "running", "path": "/runbooks/runs/12"}`), `401` for an unknown webhook or a wrong secret, `403` when it's turned off, `409` while its last run is still going, and `400` when a value is missing.

- A webhook's run acts as `hook:<name>` with an **operator's** rights: with `APPROVAL_REQUIRED=risky`, a run with a risky step waits for an admin.
- **Test call…** sends a body from the page, as a tool would, and opens the run it starts.
- Each webhook shows when it was last called and its last run, or why the call failed.
- A runbook a webhook starts can't be deleted until the webhook is.

:::caution
A value the call sets is used as sent, in targets too. Let a call set only what the runbook can take safely from whoever has the secret, and keep the server behind HTTPS so the secret isn't sent in the clear.
:::

:::note
Runs are kept in the database and worked through by whichever server instance gets to them first, so a run carries on when the instance that started it restarts. A step that was being started at that very moment is marked failed rather than run twice.
:::
