# Changelog

## Unreleased

**Runbooks**

- **Run again** on a finished run opens the form with its values. A run that stopped or failed can **Continue from step N**: a new run, as you, from the step that stopped it, with the same values; the steps before it stay as they ran, linked to their run. See [Running one](https://pipozzz.github.io/salt-shaker/guide/runbooks/#running-one).
- A runbook can end with **steps for a failure**: they run only when a step stops the run, to put things back (start the service again, roll back), and are skipped when all goes well. The run then ends with the error of the step that stopped it. See [Writing one](https://pipozzz.github.io/salt-shaker/guide/runbooks/#writing-one).

## 1.27.0

**Runbooks**

- A run's page shows what each minion returned under each step, failures first, without opening the job; a step that failed shows it right away, and a running one fills in as minions return.

**Upgrading**

- Nothing to do: the step output comes from the job history the server already keeps.

## 1.26.0

**Runbooks from a webhook**

- Monitoring, CI or a ticket system can start a runbook: admins add a webhook under **Runbooks → Webhooks**, choose which values it sets and which a call may set, and get a secret shown once. A call sends it as a bearer token or signs its body like Salt Shaker's own webhooks. The run acts as the webhook with an operator's rights, so approvals apply; one runs at a time, and **Test call…** tries it from the page. See [From a webhook](https://pipozzz.github.io/salt-shaker/guide/runbooks/#from-a-webhook).

**Upgrading**

- The database gains a table for runbook webhooks when the server starts; nothing to do. Calls to `/api/hooks/` don't sign in, so if a reverse proxy in front of Salt Shaker limits who reaches it, let the tools that call webhooks through to that path.

## 1.25.0

**Runbooks on a schedule**

- A schedule can run a runbook with set values, for example *Sync and apply the highstate* on `web-*` every Tuesday night inside a maintenance window. The run acts as the schedule, a new one waits until the last has finished, and the schedule links to its runs; how they ended goes to **Runbook runs**. A runbook a schedule runs can't be deleted from under it. See [On a schedule](https://pipozzz.github.io/salt-shaker/guide/runbooks/#on-a-schedule).

**Upgrading**

- Nothing to do: runbook schedules use the existing tables.

## 1.24.0

**Runbooks**

- Save a procedure your team repeats as a **runbook**: a few steps, each a function on a target, with values asked for each time (`{{host}}`, `{{service}}`). Operators run it from **Runbooks**; each step runs as them, through the same role, scope and audit checks as Run, waits for its minions, and stops the run when it fails unless it may. With `APPROVAL_REQUIRED=risky`, an operator's run with a risky step waits for an admin. A new **Runbook runs** notification says how runs ended. See [Runbooks](https://pipozzz.github.io/salt-shaker/guide/runbooks/).

**Upgrading**

- The database gains tables for runbooks and their runs when the server starts; nothing to do. Runbooks show up in the menu once you upgrade; there are none until an admin writes one.

## 1.23.0

**Fixing drift**

- A compliance schedule can fix the drift it finds: with **Fix the drift it finds** ticked, a check that finds drifted minions starts a change that applies the highstate to just those, in batches and stopped by failures. Minions with errors are left for a person, one fix runs at a time, and with a maintenance window both the check and the fix stay inside it. See [Fixing drift](https://pipozzz.github.io/salt-shaker/guide/schedules/#fixing-drift).

**Upgrading**

- Schedules gain a column for their fix when the server starts; nothing to do. Existing compliance schedules don't fix anything until you tick **Fix the drift it finds**.

## 1.22.0

**Fleet report**

- A **Report** page for admins puts the last seven days on one page to hand on: the weekly report's numbers with the change since last week, compliance and who needs a look, minions not answering, the 30-day vulnerability trend and the most exposed minions. **Print or save as PDF** prints it without the menus, on white. See [Printable report](https://pipozzz.github.io/salt-shaker/guide/schedules/#printable-report).

**Email notifications**

- A notification channel can now be **Email**: up to 20 recipients, each message as a plain email with a link back, so the weekly report and alerts reach people outside chat. Set `SMTP_URL` (and `SMTP_FROM`) on the server; see [Email](https://pipozzz.github.io/salt-shaker/guide/schedules/#email).

**Maintenance windows**

- Admins set when changes are expected on **System → Maintenance windows** (weekdays, a local start time, how long, a time zone). A schedule tied to a window waits for it to open instead of running at its cron slot, and Run and Changes say when you're outside every window and when the next opens. See [Maintenance windows](https://pipozzz.github.io/salt-shaker/guide/schedules/#maintenance-windows).

**Upgrading**

- The database gains a table for maintenance windows, and schedules a column for theirs, when the server starts; nothing to do. Email stays off until you set `SMTP_URL`.

## 1.21.0

**Several masters**

- Link the Salt Shaker of each master (**System → Other masters**, with a viewer's API token from each): the overview shows **All masters** side by side (minions, not answering, failed jobs, critical vulnerabilities, pending keys, approvals), and a switcher in the sidebar opens another one. Each instance is named with `INSTANCE_NAME` and sums itself up at `GET /api/summary`. See [Several masters](https://pipozzz.github.io/salt-shaker/deploy/masters/).

**Deploying**

- `deploy/` starts from a plain `compose.yml`: Salt Shaker alone with SQLite on port 8080. Caddy with automatic HTTPS, Postgres and an existing Traefik are add-on files chosen with one line in `.env` (`COMPOSE_FILE=compose.yml:compose.caddy.yml`), and every setting in `.env` reaches the container, so any variable from the configuration reference works there without editing a compose file. Needs Docker Compose 2.24 or newer.

**Upgrading**

- `deploy/docker-compose.yml`, `docker-compose.sqlite.yml` and `Caddyfile` are gone. In your `.env`, add `PUBLIC_URL=https://<your DOMAIN>` and the line that picks your old setup: `COMPOSE_FILE=compose.yml:compose.caddy.yml:compose.postgres.yml` (was `docker-compose.yml`) or `COMPOSE_FILE=compose.yml:compose.caddy.yml` (was `docker-compose.sqlite.yml`). Volume names stay the same, so data and certificates carry over. Until `PUBLIC_URL` is set, `docker compose up` stops with a message instead of starting an empty instance.
- The database gains a table for the other instances when the server starts; nothing to do.

## 1.20.1

**Fixes**

- The Slack **/salt** command answered every request with "Not signed in": its endpoint sat behind the check for a signed-in user. Slack's signed requests now reach it.

## 1.20.0

**Map**

- A **Map** of the fleet: every minion as a tile, grouped by network, role, operating system or platform (two levels), and coloured by whether it answers, its compliance, its vulnerabilities or its Salt version, with a legend and a bar per group. A tile opens the minion.

**Slack**

- A **/salt** command for Slack (`SLACK_SIGNING_SECRET`): `status`, `highstate <target> [test]` and `run <target> <function> [args]`. Each Slack user links their Salt Shaker user once (`/salt link`, confirmed in the browser) and acts with its role, limits and approvals; commands are audited under their name, posted in the channel with a link to the job, and followed by how the job went. See [Slack](https://pipozzz.github.io/salt-shaker/guide/slack/) for setting up the app.

## 1.19.1

**Fixes**

- The 1.19.0 build stopped at a flaky end-to-end test, so its image wasn't published; 1.19.1 is the same release with the test fixed.

## 1.19.0

**Compliance**

- **Hardening checks**: 15 common Linux hardening checks of the kind CIS benchmarks recommend (SSH, accounts, file permissions, network and kernel settings, auditd, time sync), read with osquery in one query per minion. Each minion gets a score, each check lists the minions that fail it, and **Evidence (CSV)** saves the results with the time and job for an audit.

## 1.18.0

**Enrollment**

- **Quiet for a while** on the Keys page lists the accepted minions that don't answer and haven't for 7 to 180 days, usually machines that are gone, and deletes their keys together. The server now keeps when each minion last answered the presence check.

**Notifications**

- A **Weekly report** for channels that tick it, on Mondays at 8:00: minions accepted, not answering and quiet for long, jobs run and failed, changes, critical and high vulnerabilities with the change over the week, and commands by how many people. The Notifications page shows it as it stands and can send it now.

## 1.17.0

**Enrollment**

- **Enrollment windows**: while bringing up servers, an admin accepts new minions whose id matches a pattern (e.g. `web-2026-*`) as they arrive, for 1 to 72 hours and up to a number, instead of one by one. Windows always end, `*` alone isn't allowed, and every accept is audited and notified.

**Minions**

- **Compare** two minions: select them on the list to see the grains that differ (names, addresses and ids set apart) and the packages that differ in version or are on only one of them. Nothing runs on the minions.

## 1.16.0

**Changes: batched rollouts and approvals**

- On **Run**, **Roll out in batches** sends a command to a few minions at a time (a number, or a share like 25%) and stops when more minions fail than allowed; minions that don't answer within 15 minutes count as failed. Each rollout is a **change** with a reason, on the new **Changes** page: its batches, each minion's outcome as it goes, and a **Stop** button.
- With `APPROVAL_REQUIRED=risky`, an operator's command that changes minions isn't run directly: it becomes a change that an admin other than the requester approves (or rejects with a reason) first. Requests, decisions and stops are audited, and the new **Approvals** and **Changes** notifications say when one waits or a rollout stopped. The overview lists changes waiting for approval and rollouts that stopped.
- The demo has a change from Olga waiting for approval, and a rollout from earlier.

**API tokens**

- Personal **API tokens** for scripts and CI: a token acts as its user (role, limits, approvals) and everything it does is audited under their name. It's shown once, only its hash is kept, it can expire, and it stops when the user is disabled. The new [API reference](https://pipozzz.github.io/salt-shaker/reference/api/) shows how to run commands, roll out changes from a pipeline and read the vulnerability report.

**Compliance**

- **Preview a branch** shows what a branch of your states (a gitfs saltenv) would change before you merge it: the highstate is dry-run from the branch and from base on the same minions, and only the states whose outcome differs are listed (would fail, would change, new, not applied any more, no longer changes). Operators and viewers may now list salt environments (`fileserver.envs`).

**Fixes**

- The sidebar scrolls when the screen is too short for every page, instead of hiding the last ones (Users, System) below the edge.

**Users & roles**

- Admins can limit an operator to some minions (**Can run on** on the Users page, e.g. `G@roles:db`). The server checks every call they make against it: a target that reaches other minions is refused and audited, the rest runs on exactly the matching minions, and runners that change something (orchestrations) are refused. The target field shows limited users what they can run on.

## 1.15.0

**Overview**

- A new **Overview** home page shows how the fleet is doing: minions responding, drifted or failing minions, minions to patch, critical and high vulnerabilities and failed jobs of the last day, each opening its page. **Needs attention** lists what to look at, worst first (minions down, highstate errors, fixable critical vulnerabilities, keys waiting, drift, failed jobs, stale checks, risk acceptances ending), with a button to where it gets fixed, next to the 90-day vulnerability trend.
- The minions list moved to **Minions** (`/minions`); old links with its filters still open it.

**Docs**

- A new landing page for the docs site: what Salt Shaker does, with a screenshot of each part, how it talks to your master, and how to try or deploy it, in light and dark.

**Minions**

- A **Packages** tab on each minion's page lists everything installed according to its latest vulnerability scan, with each package's version and its known vulnerabilities; filter by name or show only the vulnerable ones.

## 1.14.0

**Demo**

- The demo has **Users** (a made-up team with every role, to try role changes and locking accounts) and a **System** page, so every page can be tried without a server.

**Fixes**

- On a phone, audit log entries show the call and its target on their own line instead of a few letters of it.
- Links inside sentences are underlined, the **Upgrade on N minions** button has enough contrast, and the selected library query is readable in dark mode. The new pages (vulnerabilities, Query, schedules, notifications, audit log, users, system) are now part of the accessibility and phone-width checks.

**Docs**

- Screenshots for Compliance, Patches, Run, Users and the audit log, a gallery on the landing page, and a sharp, uncropped picture at the top of it.

## 1.13.0

**Notifications**

- Generic JSON webhooks are signed: each gets a secret when it's added (shown once), and every request carries `X-Salt-Shaker-Timestamp` and an HMAC-SHA256 `X-Salt-Shaker-Signature`, so the receiver can tell it's from Salt Shaker. **New secret** replaces it; webhooks added before stay unsigned until you click **Sign**. The docs show how to verify it in Node.js and Python.

**Demo**

- The demo has an **Audit log**: what you change in the demo (commands, schedules, channels, accepted risks), what its schedules start, and a few earlier entries including denied attempts, with the same filters and CSV export as the server's.

## 1.12.0

**Vulnerabilities**

- A new **Risk acceptances** notification says when an accepted risk ends within 3 days, and again when it has ended and the vulnerability counts again. Accepting it again starts over.

**Query**

- A watched query's schedule lists what changed in its last run (**What changed in the last run**), and **Query** on a minion's page opens the Query page on that minion.

**Demo**

- The demo's schedules run real jobs on the simulated master: their past runs and **Run now** are in the job history, and the links to them open the job.

## 1.11.0

**Demo**

- The demo has **Schedules** and **Notifications** too, with a few made up to try: a nightly compliance check, a weekly patch scan, a vulnerability scan and a watched osquery query. They're kept in the browser; nothing runs on a schedule and nothing is sent.

**Vulnerabilities**

- **Installed packages** searches the package inventories across the fleet: each installed version of a package with the minions that have it, from the latest scans and without running anything on the minions.

## 1.10.0

**Query**

- New **Query** page: run an [osquery](https://osquery.io) SQL query on a target and see every minion's rows in one table, filter them and export them as CSV. A library has ready-made queries (listening ports, logged-in users, SSH keys, SUID binaries, cron jobs, kernel modules, processes, OS); with the server, operators and admins save queries for the team. Only one SELECT runs at a time, through `cmd.run`.
- The last query's results are still there after opening a minion and coming back. Click a column header to sort.
- **Copy link** shares a query and its target as a link, and ⌘K finds library and saved queries by name.
- **Group identical rows** shows each distinct row once with the minions that have it, rarest first, so what only a few minions have stands out.
- **Watch a query**: a new **osquery query** schedule kind runs a query and compares its rows with the previous run, minion by minion. The new **Query changes** notification lists what appeared or went away (a new port, account or SSH key); the first run is the baseline. **Watch…** on the Query page starts one.
- Minions without osquery are listed with **Install osquery…**, which adds the official `pkg.osquery.io` repository and installs it with apt or dnf/yum.

**Vulnerabilities**

- Risk can be accepted for 7 days too, and acceptances ending within a week are flagged on the **Accepted** tab.
- A **Last 90 days** chart on the Vulnerabilities page shows how the critical, high and fixable vulnerabilities changed, from totals the server keeps for every day.

## 1.9.0

**Vulnerabilities**

- New **Vulnerabilities** page: a scan lists the packages installed on each minion (`dpkg`, `rpm` or `apk`, read-only), and the server checks them against [OSV.dev](https://osv.dev), which gathers the Debian, Ubuntu, AlmaLinux, Rocky Linux and Alpine security trackers. See every vulnerability by severity or by minion, with the installed and the fixed version, filter to the ones with a fix, and open Run with the upgrade for the affected minions.
- A **Vulnerability scan** schedule keeps the results current: its summary counts the critical and high vulnerabilities and how many have a fix, and the new **Vulnerabilities** notification event alerts when an upgrade fixes a critical or high one. The Minions list shows each minion's counts and its CSV export includes them.
- Each minion's latest inventory from the last 30 days counts; minions whose key was deleted drop out, and inventories older than a week are marked.
- Each minion's page has a **Vulnerabilities** tab, and **Export CSV** downloads every finding with the page's filters, one row per minion and package.
- **Patches** marks the pending upgrades that fix a known vulnerability (when the version on offer reaches the fixed one), with the worst severity, sorts them first and can show only them; **Upgrade security fixes** upgrades only those, only on the minions they fix. After an upgrade, those minions' package inventory is refreshed so the vulnerability report is current.
- **Accept risk** on a vulnerability, with a reason and for 30 days, 90 days, a year or until withdrawn, leaves it out of the counts, alerts, export and Patches; the **Accepted** tab lists them and withdraws them. Operators and admins can accept; the audit log records each acceptance with its reason, each withdrawal, and denied attempts.
- The server needs to reach `https://api.osv.dev`; `OSV_API_URL` points it elsewhere.

**Minions**

- **Export CSV** downloads the minions the search and filters match as an inventory spreadsheet: status, OS, kernel, IPs, CPUs, memory, roles and Salt version, plus the latest compliance result and pending upgrades with the server.

## 1.8.0

**Jobs**

- **Export CSV** on the Jobs history downloads every job matching the search and result filter, with who started it and how many minions returned and failed.

**Saved targets**

- With the server, saved targets are shared with the whole team instead of living in one browser: operators and admins save them, everyone picks them on Run, Schedules and in ⌘K, and only whoever saved one (or an admin) can replace or remove it. Targets you saved in your browser before show a dashed outline and **Share with the team** moves them over.

## 1.7.0

**Results**

- **By output** groups a job's results by identical output, with the minions that returned each one, biggest group first, so the few minions with another package version or kernel stand out. Each group has **Run on these**, which fills in Run with its minions, and **Copy IDs**. It's on Run, job details and orchestration results; state runs keep their per-minion view.

## 1.6.0

**Minions**

- Tick minions on the Minions page and **Run on selected** opens Run with them as a list target. The header box picks every minion the filter shows, and the selection stays while you search.

**Jobs**

- A **Result** filter in the Jobs history shows only jobs where a minion failed, or only dry runs. It combines with the search and is kept in the address.

**Schedules**

- Each schedule shows its last 10 runs as a strip of bars, colored by how they went and linked to their jobs, with a link to all of its jobs in the history (only the failed ones when some failed). A schedule that keeps failing now stands out even when its latest run was fine.

**Fixes**

- Schedules running `test.ping`, `grains.*` or other functions the history skips as noise reported every minion as *no return* after 15 minutes. Their jobs and returns are now recorded.

## 1.5.0

**System page**

- A **System** page for admins shows whether this install works: whether salt-api answers the service account (and why not), which instance follows the event bus and when it last got an event, the database, schedules, notification channels whose last delivery failed, and the settings the server picked up (public URL, SSO, time zone, metrics). It also tells when the instance holding the event bus crashed and when another takes over.

**Minions**

- A minion's page keeps its tab (Grains, Pillar, Jobs) and key filter in the address, so going back from one of its jobs returns to the Jobs tab, and a link can open the pillar directly.
- The **Minions** link on a minion's page returns to the list with the search and filters it had.

**Schedules**

- **Schedule…** on the Run page (admins, with the server) opens a new schedule with the function, arguments and target from the form, so a command you tried by hand can run every night.

**Users**

- The Users page shows when each user last signed in, with a password or through SSO, to spot accounts nobody uses. Sign-ins are recorded from this version on.

**Audit log**

- `AUDIT_RETENTION_DAYS` deletes audit entries older than that many days, e.g. `365`. Without it entries are kept forever, as before. The System page shows the setting.

**Notifications**

- Alerts can go to **Microsoft Teams**: a new channel format sends an Adaptive Card with a link back, for the *Post to a channel when a webhook request is received* workflow. See [Schedules & notifications](https://pipozzz.github.io/salt-shaker/guide/schedules/#notifications).

## 1.4.0

**Connecting to salt-api**

- When salt-api can't be reached, the server says why instead of "fetch failed": an untrusted or expired TLS certificate, a refused connection, a host name that doesn't resolve, a timeout, or `http://` and `https://` mixed up.
- [Prepare the master](https://pipozzz.github.io/salt-shaker/deploy/master/) shows how to trust a self-signed or internal-CA certificate with `NODE_EXTRA_CA_CERTS`.

**Minions**

- An **Updates** column on the Minions page (with the server) shows how many package upgrades each minion had in its latest patch scan, linked to that scan.

**Searches you can share**

- The Jobs history and the Audit log keep their search in the address, like the Minions page. Going back from a job returns to the same results, and a search can be bookmarked or sent, e.g. every denied attempt since a given day.

## 1.3.1

**Fixes**

- Usernames with a `-`, or of 31–32 characters, could not be created or sign in, although the setup and Users pages accept them. Setup failed with a server error.

## 1.3.0

**Minions**

- A **Drifted** filter on the Minions page (with the server) shows only the minions that drifted or failed in their latest compliance check.
- The page keeps its search and filters in the address, so they survive opening a minion and going back, and a filtered list can be bookmarked or shared.

**Jobs**

- **Running now** on the Jobs page lists the jobs minions are still running, and **Stop** kills one on those minions (`saltutil.kill_job`) after a confirmation. Viewers can see running jobs but not stop them.
- A job's page tells minions that are still running it apart from those that never returned, and can stop it there too.

## 1.2.0

**Monitoring and alerts**

- Prometheus endpoint `/metrics`, enabled with `METRICS_TOKEN`: master reachability, minion keys by status, the latest compliance check, job failures in the last 24 hours and the state of each schedule. See [Monitoring](https://pipozzz.github.io/salt-shaker/deploy/monitoring/) for the metrics and example alerts.
- New notification event *Minions down*: the server checks every 5 minutes which minions respond and alerts when one misses two checks in a row, and again when it is back. `PRESENCE_CHECK_MINUTES` sets the interval.

**Minion history**

- A **Compliance** column on the Minions page shows each minion's result in the latest compliance check it answered, linked to that check.
- A **Jobs** tab on each minion's page lists the recorded jobs that targeted it, with how each ended on that minion (ok, changed, drift, failed or no return).

**Job follow-ups**

- "Retry N failed" on run results and job details fills in Run with the minions that failed or never returned, as a list target, with the original function and arguments. You review it and start it.
- Download a job's results as CSV (one row per minion, with state counts) or JSON.

**Audit log**

- Filter by outcome and by date (whole days in UTC), alongside the text search.
- **Export CSV** downloads every entry that matches the filter, for reviews and auditors.

**Accessibility**

- Text and buttons meet WCAG 2.1 AA contrast in both themes. An axe check in the E2E suite keeps it that way.
- Dark mode no longer flashes light while the app loads.
- Code panels that scroll can be focused and scrolled from the keyboard.

**Large fleets**

- Enrollment, run results and the compliance list show long lists in pages, so pages with hundreds of minions stay responsive.

**Fixes**

- The Minions page no longer fails to show who is responding while a minion is down. The timeout for `manage.status` now goes to the runner instead of capping salt-api's request.

**Quality**

- The server's database tests run on Postgres as well as SQLite in CI.

## 1.1.0

**Faster with large fleets**

- The Minions page reads grains from the master's minion data cache instead of running `grains.items` on every minion. It shows up at once, puts no load on the minions, and offline minions keep their last known OS and IPs. With one minion offline in the lab: 15.1 s before, 0.19 s now.
- The server sends only the grains the overview uses, cached for 15 seconds and shared by all users.
- Up/down status fills in when `manage.status` answers, instead of holding up the page. The table shows 100 minions at a time.
- `?demo=large` opens the demo with 606 minions.

**Images and runtime**

- Docker images for `linux/amd64` and `linux/arm64` (Apple Silicon, Graviton, Raspberry Pi).
- Node 26 in the image and in CI.

**Deploying**

- Documentation site at https://pipozzz.github.io/salt-shaker/, covering setup, single sign-on, schedules, roles and configuration.
- Compose setups in `deploy/` for Postgres and for SQLite, both behind Caddy with automatic HTTPS.
- `sharedsecret` is the recommended eauth for the service account and the Compose default.

**Quality**

- Browser tests (Playwright) run in CI before an image is published.
- Lint fails on any warning, and all of them are fixed.
- Dependabot keeps npm packages, GitHub Actions and images up to date. It leaves Postgres major versions, which need a dump/restore, to you.

## 1.0.0

The first release.

**Console**

- Minions overview with a fleet breakdown (OS, Salt version, roles) that flags minions behind the master; per-minion grains and compiled pillar.
- Compliance: dry-run highstate across a target, grouped into in compliance / drifted / errors / no return, with diffs, one-click remediation and history.
- Patches: pending upgrades by package or by minion, with upgrades after confirmation.
- Enrollment: fingerprint-checked key management and bootstrap commands, including pre-seeded keys.
- Run: any function on any target type, with a target preview, live results over the event bus, rendered state output and confirmation for risky commands on many minions.
- Orchestrate: `state.orchestrate` with dry runs, pillar overrides and step-by-step results.
- Jobs, States & Pillar browser, live Events, toasts, ⌘K palette, saved targets, dark mode, demo mode.

**Server**

- One container (Hono, Better Auth, Drizzle) with SQLite by default or Postgres.
- Local users with admin / operator / viewer / none roles, enforced on the server, plus single sign-on via OIDC with roles from IdP groups.
- A single salt-api service account; every call is checked against the user's role and tagged with the user in Salt's job metadata.
- Audit log of every change and every denied attempt.
- Job history recorded from the event bus, kept beyond the master's job cache (90 days by default).
- Schedules (compliance checks, patch scans, any function) and notifications to Slack-format or JSON webhooks.
- Several instances can share one Postgres database: scheduled runs start once, and one elected instance follows the event bus.

**Also**

- Direct mode: the static UI can still talk to salt-api without the server.
- Docker image on GHCR, a production compose example with Postgres and Caddy (`deploy/`), and a local Salt lab with a mock OIDC provider (`lab/`).
