---
title: Vulnerabilities
description: Known vulnerabilities in the packages installed on minions, from OSV.dev.
sidebar: { order: 3 }
---

**Vulnerabilities** shows which known vulnerabilities (CVEs and distribution advisories) affect the packages installed on your minions, and whether a fixed version is available. It needs the server; the demo shows made-up data.

## How it works

1. **A scan** lists each minion's installed packages. It runs a short shell script with `cmd.run` (`dpkg-query`, `rpm` or `apk`, read-only) and shows up in Jobs like any other job. Nothing is installed on the minions.
2. **The server** matches the package versions against [OSV.dev](https://osv.dev), which collects the distributions' own security trackers: the Debian Security Tracker, Ubuntu's CVE tracker, AlmaLinux and Rocky Linux errata and Alpine's secdb. Every package version in the fleet is asked about once, and the answers are cached in the database: package versions for 12 hours, vulnerability records until OSV.dev reports a change.

The first check of a fleet fetches every vulnerability record once and can take a minute; the page shows the progress and fills in when it's done. After that, a new scan is checked in seconds.

Covered: **Debian**, **Ubuntu**, **AlmaLinux**, **Rocky Linux** and **Alpine**. Other systems (e.g. RHEL, CentOS, SUSE, Windows) show as *not covered*.

Operators and admins can scan (it needs `cmd.run`); everyone signed in sees the results. To keep them current, add a [schedule](/salt-shaker/guide/schedules/) of kind **Vulnerability scan**, for example every night.

## Reading the results

- **By vulnerability** lists every vulnerability found, worst first, with the affected package, a summary and on how many minions it was found. Open one to see each minion's installed version and the version that fixes it.
- **By minion** shows each minion's counts per severity and how many have a fix; open a minion to see its list.
- Filter by severity, search for a CVE, package or text, and tick **Fix available** to hide the ones nobody can fix yet. The filters are kept in the page address.
- **Upgrade on N minions** opens [Run](/salt-shaker/guide/run/) with `pkg.install pkgs=[…] only_upgrade=True` for the minions that have a fix. Nothing runs until you start it there.

The [Minions](/salt-shaker/guide/minions/) list gets a **Vulnerabilities** column once there is a scan, and its CSV export includes the counts.

### Severity

The rating is the distribution's own when it has one: Ubuntu's priority, the Red Hat style rating of AlmaLinux and Rocky Linux advisories, or Debian's urgency. Distributions rate a CVE for how the package is built and used there, so it can be lower than the CVSS score; Debian, for instance, marks disputed issues *unimportant*. Without a distribution rating, the CVSS v3 base score decides (9.0 and up critical, 7.0 high, 4.0 medium). The score is shown next to the rating. *Unrated* means neither is known yet.

### Things to know

- Debian and Ubuntu track many CVEs that they decided not to fix in a stable release, or haven't yet; those show *no fix yet*. **Fix available** narrows the list to what an upgrade solves.
- The installed kernel package is checked, not the running kernel: after a kernel upgrade, a minion is only safe once it rebooted.
- Packages from other repositories (Docker, PostgreSQL's own, PPAs, your own builds) are matched by name against the distribution's data, which may not be right for them.
- The results are only as good as the trackers; treat them as a guide for patching, not as an audit.

## Network access

The server calls `https://api.osv.dev` (no account or key). Behind a proxy, set `HTTPS_PROXY` together with `NODE_USE_ENV_PROXY=1` (Node only reads proxy variables then), and list salt-api and your identity provider in `NO_PROXY` if they're reached directly. `OSV_API_URL` points it at another server with the same API. When OSV.dev can't be reached, the page says so and shows what was cached.
