---
title: Patches
description: Pending package upgrades across the fleet.
sidebar: { order: 3 }
---

**Patches** lists pending package upgrades across the fleet, grouped by package or by minion, with the installed and available versions.

You can upgrade one package on every minion where it's pending, or everything on one minion.

## Security fixes

With the server or in the demo, upgrades that fix a vulnerability from the latest [vulnerability report](/guide/vulnerabilities/) are marked in the **Fixes** column with the worst severity and the number of vulnerabilities. They're sorted to the top, and **Fixes vulnerabilities** shows only them. A badge links to the vulnerability on the Vulnerabilities page.

The match is by package name: if the repository only offers a version older than the fix, the badge still shows. Run a vulnerability scan after upgrading to confirm.
