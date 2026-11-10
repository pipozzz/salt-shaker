# Changelog

## Unreleased

**Demo**

- The demo has **Users** (a made-up team with every role, to try role changes and locking accounts) and a **System** page, so every page can be tried without a server.

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
