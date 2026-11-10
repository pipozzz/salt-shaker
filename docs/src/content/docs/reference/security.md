---
title: Security
description: Sessions, passwords, reporting vulnerabilities and the license.
---

- Sessions are httpOnly cookies, valid for 12 hours and extended while in use. Cross-origin state-changing requests are refused.
- Passwords must be at least 10 characters. Sign-in attempts are rate-limited per client IP. Self-registration is off; only admins create accounts.
- [Single sign-on](/salt-shaker/deploy/sso/) uses PKCE and checks the `id_token` nonce. `PASSWORD_LOGIN=admins` keeps passwords as a break-glass for admins only.
- The UI hides what a role can't do, and the server enforces it. Denied attempts are recorded in the audit log.
- The user's own credentials and session never reach salt-api; the server uses its service account.
- Webhook URLs for notifications are stored on the server and shown masked.
- Pre-seeded enrollment shows a minion's private key once. Copy it over a trusted channel.
- The vulnerability check sends OSV.dev the names and versions of installed packages, with the distribution, and nothing else: no host names, IPs or minion IDs. `OSV_API_URL` points it at a mirror instead.
- The Query page runs only a single `SELECT`, through `cmd.run`, so it's audited and needs the same permission. osquery can read sensitive tables (e.g. `shadow`), which is why viewers can't run queries.
- **Install osquery** makes the minions download the osquery package and its signing key from `pkg.osquery.io` over HTTPS; apt or dnf checks the package against that key.

## Reporting a vulnerability

Use GitHub's private [security advisories](https://github.com/pipozzz/salt-shaker/security/advisories/new) rather than a public issue.

## License

Salt Shaker is licensed under the [GNU Affero General Public License v3.0 or later](https://github.com/pipozzz/salt-shaker/blob/main/LICENSE).

If you run a modified version for others over a network, the AGPL requires you to offer them its source. The UI links to the source in the sidebar and on the login page; set `VITE_SOURCE_URL` to your fork.
