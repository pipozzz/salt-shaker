---
title: Patches
description: Pending package upgrades across the fleet.
sidebar: { order: 3 }
---

**Patches** lists pending package upgrades across the fleet, grouped by package or by minion, with the installed and available versions.

You can upgrade one package on every minion where it's pending, or everything on one minion.

## Security fixes

With the server or in the demo, upgrades that fix a vulnerability from the latest [vulnerability report](/guide/vulnerabilities/) are marked in the **Fixes** column with the worst severity and the number of vulnerabilities. They're sorted to the top, and **Fixes vulnerabilities** shows only them. A badge links to the vulnerability on the Vulnerabilities page.

**Upgrade security fixes** upgrades just those packages, only on the minions where they fix something (`pkg.install pkgs=[…] only_upgrade=True`). It needs permission for `pkg.install`.

A vulnerability counts only when the version on offer reaches the version it's fixed in, compared the way `dpkg` or `rpm` would. If the repository only offers an older version, the expanded minion row says **fix needs** and the version. Run a vulnerability scan after upgrading to confirm.
