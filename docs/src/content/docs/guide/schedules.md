---
title: Schedules & Notifications
description: Run checks on a schedule and send alerts to Slack, Microsoft Teams or a webhook.
sidebar: { order: 7 }
---

Both pages are for admins and need the server.

## Schedules

**Schedules** runs jobs on a cron schedule:

- **Compliance check**: `state.apply test=True`, the same as the [Compliance](/salt-shaker/guide/compliance/) page.
- **Patch scan**: `pkg.list_upgrades`, the same as [Patches](/salt-shaker/guide/patches/).
- **Any function**, with arguments, for example `saltutil.sync_all`. **Schedule…** on the [Run](/salt-shaker/guide/run/) page starts one from the function and target you're about to run.

You can pick a preset such as *Every day at 02:00* or *Weekdays at 06:00*, or write your own cron expression. Times use the server's time zone; in the container, set it with `TZ`.

Each schedule shows when it runs next, a summary of its last run with a link to the job, and a **Run now** button. Below the summary, a bar for each of its last 10 runs shows how they went: green ok, amber drifted (or updates available), red failed, gray when some minions did not return. Hover a bar for the details or click it to open that job; the link next to them opens all of the schedule's jobs. Scheduled jobs appear in history and in the audit log as `schedule:<name>`, so renaming a schedule starts its list of runs anew.

:::note
With several server instances on one database, each scheduled run still starts exactly once.
:::

## Notifications

**Notifications** sends alerts to webhooks. Each channel picks which events it gets:

| Event | When |
| --- | --- |
| Drift | a scheduled compliance check found drifted minions or errors |
| Patches | a scheduled patch scan found upgrades |
| Every scheduled run | any schedule finished, with its summary |
| Failed jobs | a job failed on any minion; failures of one job are combined into one alert |
| Pending keys | a new minion is waiting for approval; at most once every 6 hours per minion |
| Minions down | a minion missed two checks in a row (`manage.status`, every 5 minutes by default), and again once it answers |

Minions that are already down when the server starts are not reported, only the ones that go down while it is watching. Set `PRESENCE_CHECK_MINUTES` to change the interval, or to `0` to turn the check off.

There are three formats:

- **Slack-compatible**, for Slack incoming webhooks. Mattermost and Rocket.Chat accept it too, and so does Discord if you append `/slack` to its webhook URL.
- **Microsoft Teams**, an Adaptive Card with a link back. In Teams, add the *Post to a channel when a webhook request is received* workflow to the channel (channel **⋯ → Workflows**) and paste the URL it gives you. The older Office 365 connectors are retired and are not supported.
- **Generic JSON webhook**, for anything else:

```json
{
  "source": "salt-shaker",
  "event": "job_failed",
  "severity": "error",
  "title": "cmd.run failed on 2 minions",
  "lines": ["Minions: web-01, web-02", "Started by: otto"],
  "url": "https://salt.example.com/jobs/20261101192517728905",
  "at": "2026-11-01T19:25:33.211Z"
}
```

The **Test** button sends a test message. If a channel fails, its last error is shown next to it.

Webhook URLs contain secrets, so the UI only shows enough of them to recognize which is which. To change one, enter a new URL.
