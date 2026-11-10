---
title: Roles
description: What admins, operators and viewers can do, and the none role.
---

| Role | Can do |
| --- | --- |
| **admin** | Everything, including accepting keys and managing users. |
| **operator** | Runs anything on minions (states, commands, packages, orchestration). Can't manage keys, users or files on the master. |
| **viewer** | Read-only. Sees minions, jobs and states, but not pillar data, which often holds secrets. |
| **none** | Can't sign in. Use it to switch off an account, or for SSO users who haven't been granted a role yet. |

A role the server doesn't know gets no permissions at all.

## The console's own features

Some features are the server's, not Salt calls. Who may use them:

| Feature | admin | operator | viewer |
| --- | --- | --- | --- |
| Schedules and notification channels | manage | no | no |
| Shared [saved targets](/salt-shaker/guide/run/) | save, remove any | save, remove own | use |
| Team [saved queries](/salt-shaker/guide/query/#saved-queries) | save, remove any | save, remove own | see |
| [Accept a vulnerability's risk](/salt-shaker/guide/vulnerabilities/#accepting-a-risk), withdraw it | yes | yes | no |
| [Audit log](/salt-shaker/guide/users-audit/#audit-log) | see, export | see, export | no |
| Users | manage | no | no |

Running a [query](/salt-shaker/guide/query/) or a [vulnerability scan](/salt-shaker/guide/vulnerabilities/) is a `cmd.run` call, so it follows the Salt rules below: operators and admins can, viewers can't. Viewers still see the vulnerability report.

The UI hides what a role can't do, and the server enforces it. Denied attempts are recorded in the [audit log](/salt-shaker/guide/users-audit/#audit-log).

## In eauth format

Roles are written in Salt's eauth format, in `server/roles.ts`. The UI and the server read the same rules.

```yaml
admin:
  - '.*'
  - '@wheel'
  - '@runner'
  - '@jobs'

operator:
  - '.*'
  - '@jobs'
  - '@runner': [manage.status, manage.versions, cache.grains, jobs.*, pillar.show_pillar, salt.cmd, state.orchestrate]
  - '@wheel': [key.list_all, key.finger, file_roots.list_roots, file_roots.read, file_roots.list_env]

viewer:
  - test.ping
  - grains.*
  - pkg.list_upgrades
  - pkg.version
  - sys.list_functions
  - saltutil.find_job
  - '@runner': [manage.status, cache.grains, jobs.*, salt.cmd]
  - '@wheel': [key.list_all, key.finger, file_roots.list_roots, file_roots.read, file_roots.list_env]

none: []
```

For everyone but admins, the runner `salt.cmd` is limited to `test.version`, because it would otherwise run any function on the master itself.
