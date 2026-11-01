# Changelog

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
