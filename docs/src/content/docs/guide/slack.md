---
title: Slack
description: Run Salt from Slack with the /salt command, as your own Salt Shaker user.
sidebar: { order: 11 }
---

With a Slack app, `/salt` runs commands from any Slack channel. Each Slack user acts as the Salt Shaker user they linked, with that user's role, the minions they're [limited to](/salt-shaker/reference/roles/#limiting-what-someone-can-run-on) and the [approvals](/salt-shaker/guide/changes/#approvals) their commands need. Everything is in the [audit log](/salt-shaker/guide/users-audit/#audit-log) under their name. It needs the server and a public URL Slack can reach.

## Commands

| Command | What it does |
| --- | --- |
| `/salt link` | gives you a link (only you see it) to connect your Slack account to your Salt Shaker user |
| `/salt status` | how many minions answer, and which don't |
| `/salt highstate <target> [test]` | applies the highstate, or dry-runs it with `test` |
| `/salt run <target> <function> [args] [key=value]` | any function your role allows, e.g. `/salt run web-* service.restart nginx` |
| `/salt whoami`, `/salt unlink` | who you act as; disconnect |

Targets are globs (`web-*`), lists (`web-01,web-02`) or compound (`G@os:Debian and web-*`). Quote arguments with spaces: `/salt run db-01 cmd.run "df -h"`.

A command that starts a job is posted in the channel, with who ran it and a link to the job, and a second message says how it went once the minions have returned (up to 2 minutes): how many succeeded, which failed, which haven't returned. Refusals (no permission, outside your access, needs approval) only you see. A command that needs approval can't be requested from Slack; the reply links to **Run**, where you roll it out as a change.

## Linking your account

Run `/salt link` in Slack and open the link within 15 minutes, signed in to Salt Shaker. **Link my Slack account** connects them. The link is signed and names your Slack account, so no one can link theirs to you without your Salt Shaker session. Your linked account shows under **API tokens**, with **Unlink**. When your Salt Shaker user is disabled or loses its role, the Slack account stops working.

## Setting up the Slack app

1. At [api.slack.com/apps](https://api.slack.com/apps), **Create New App** → *From scratch*, in your workspace.
2. **Slash Commands** → **Create New Command**: command `/salt`, request URL `https://<your Salt Shaker>/api/slack/commands`, a short description and the usage hint `status | highstate <target> | run <target> <function>`.
3. **Install App** to the workspace.
4. From **Basic Information**, copy the **Signing Secret** and set it as `SLACK_SIGNING_SECRET` on the server, then restart it. `PUBLIC_URL` has to be the address people open, since the links in Slack's replies point there.

Salt Shaker checks every request's signature and refuses ones older than 5 minutes. It only answers to the response URL Slack sends (`https://hooks.slack.com/commands/…`), and it needs no Slack token: it doesn't read your workspace.
