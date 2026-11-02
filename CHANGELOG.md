# Changelog

## Unreleased

**Job follow-ups**

- "Retry N failed" on run results and job details fills in Run with the minions that failed or never returned, as a list target, with the original function and arguments. You review it and start it.
- Download a job's results as CSV (one row per minion, with state counts) or JSON.

**Minion history**

- A **Jobs** tab on each minion's page lists the recorded jobs that targeted it, with how each ended on that minion (ok, changed, drift, failed or no return).

**Audit log**

- Filter by outcome and by date (whole days in UTC), alongside the text search.
- **Export CSV** downloads every entry that matches the filter, for reviews and auditors.

**Monitoring**

- Prometheus endpoint `/metrics`, enabled with `METRICS_TOKEN`: master reachability, minion keys by status, the latest compliance check, job failures in the last 24 hours and the state of each schedule. See [Monitoring](https://pipozzz.github.io/salt-shaker/deploy/monitoring/) for the metrics and example alerts.

**Accessibility**

- Text and buttons meet WCAG 2.1 AA contrast in both themes. An axe check in the E2E suite keeps it that way.
- Dark mode no longer flashes light while the app loads.
- Code panels that scroll can be focused and scrolled from the keyboard.

**Large fleets**

- Enrollment, run results and the compliance list show long lists in pages, so pages with hundreds of minions stay responsive.

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
