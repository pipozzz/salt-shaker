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

## Limiting what someone can run on

An admin can limit an operator to some minions: on **Users**, click *whole fleet* under **Can run on** and enter a target, e.g. `G@roles:db` (compound) or `web-*`. Everything they start then goes through a check on the server:

- The target they ask for is matched against the master's grains cache. If it matches any minion outside their limit, the call is refused, naming those minions, and the refusal is in the audit log.
- Otherwise it runs on exactly the minions it matched, as a list target, so a minion that joins later can't slip in between.
- Runners and wheel calls that change something (orchestrations, key changes) don't run on a target, so limited users can't start them.

This covers Run, Compliance, Patches, Query, vulnerability scans and upgrades alike, since all of them go through the same check. The target field shows limited users what they can run on. **Whole fleet** in the same dialog lifts the limit; setting and lifting it are audited (`user.set_scope`, `user.clear_scope`).

### What a limited user sees

A limited user also sees only their minions, wherever the console shows what a minion has or did:

- **Minions, Map and Overview**: their minions, with their grains, status, compliance and updates, and their notes.
- **Jobs**: jobs that ran on any of their minions, listing only those, with returns and failures counted on them. A job's returns are theirs only, in the job history and in what the master's job cache answers (`jobs.lookup_jid`, `jobs.list_job`, `jobs.list_jobs`, `jobs.active`).
- **Compliance, Failures and Patches**: the checks, failures and scans of their minions.
- **Vulnerabilities**: findings and installed packages on their minions. The 90-day trend is the whole fleet's, so it isn't shown to them.
- **Live events**: only the returns, starts and key events of their minions. Runner and wheel jobs, whose returns are about the whole fleet, aren't sent.
- **Salt reads**: `manage.status`, `manage.versions`, `cache.grains` and the key lists answer for their minions only, and `pillar.show_pillar` works for their minions only. Other runner and wheel reads that would show the whole fleet are refused.

Which minions those are is worked out from the master's grains cache, as for running, and again every minute or so, so a minion that joins the fleet and matches their target shows up for them by itself.

Who did what stays visible to everyone who may see it: the [audit log](/salt-shaker/guide/users-audit/#audit-log), [changes](/salt-shaker/guide/changes/) and runbook runs name the minions they ran on, whoever they are. The counts other instances read for the instance switcher are the whole fleet's.

## The console's own features

Some features are the server's, not Salt calls. Who may use them:

| Feature | admin | operator | viewer |
| --- | --- | --- | --- |
| Schedules and notification channels | manage | no | no |
| Shared [saved targets](/salt-shaker/guide/run/) | save, remove any | save, remove own | use |
| Team [saved queries](/salt-shaker/guide/query/#saved-queries) | save, remove any | save, remove own | see |
| [Accept a vulnerability's risk](/salt-shaker/guide/vulnerabilities/#accepting-a-risk), withdraw it | yes | yes | no |
| [Audit log](/salt-shaker/guide/users-audit/#audit-log) | see, export | see, export | no |
| [Changes](/salt-shaker/guide/changes/): request, stop their own | yes | yes | no |
| Approve or reject someone else's change | yes | no | no |
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
  - '@runner': [manage.status, manage.versions, cache.grains, jobs.*, pillar.show_pillar, salt.cmd, state.orchestrate, fileserver.envs, fileserver.file_list]
  - '@wheel': [key.list_all, key.finger, file_roots.list_roots, file_roots.read, file_roots.list_env]

viewer:
  - test.ping
  - grains.*
  - pkg.list_upgrades
  - pkg.version
  - sys.list_functions
  - saltutil.find_job
  - '@runner': [manage.status, cache.grains, jobs.*, salt.cmd, fileserver.envs, fileserver.file_list]
  - '@wheel': [key.list_all, key.finger, file_roots.list_roots, file_roots.read, file_roots.list_env]

none: []
```

For everyone but admins, the runner `salt.cmd` is limited to `test.version` and to `cp.get_file_str` of one `salt://` file (how **States & Pillar** reads states from gitfs), because it would otherwise run any function on the master itself.
