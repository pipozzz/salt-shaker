---
title: Schedules & Notifications
description: Run checks on a schedule and send alerts to Slack or a webhook.
sidebar: { order: 7 }
---

Both pages are for admins and need the server.

## Schedules

**Schedules** runs jobs on a cron schedule:

- **Compliance check**: `state.apply test=True`, the same as the [Compliance](/salt-shaker/guide/compliance/) page.
- **Patch scan**: `pkg.list_upgrades`, the same as [Patches](/salt-shaker/guide/patches/).
- **Any function**, with arguments, for example `saltutil.sync_all`.

You can pick a preset such as *Every day at 02:00* or *Weekdays at 06:00*, or write your own cron expression. Times use the server's time zone; in the container, set it with `TZ`.

Each schedule shows when it runs next, a summary of its last run with a link to the job, and a **Run now** button. Scheduled jobs appear in history and in the audit log as `schedule:<name>`.

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

There are two formats:

- **Slack-compatible**, for Slack incoming webhooks. Mattermost and Rocket.Chat accept it too, and so does Discord if you append `/slack` to its webhook URL.
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
