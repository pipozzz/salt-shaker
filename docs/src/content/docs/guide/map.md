---
title: Map
description: The fleet as a picture, grouped by network, role, OS or platform and coloured by its state.
sidebar: { order: 1 }
---

**Map** shows every accepted minion as a tile, in nested groups by what they share, coloured by one state at a time. It answers "where is the trouble?" at a glance: a subnet where nothing answers, a role that drifted, an OS release full of critical vulnerabilities.

- **Group by** and **Then by**: network (the /24 of the first address that isn't loopback), role (the first of the `roles` grain), operating system and major release, platform (the `virtual` grain: physical, kvm, VMware…) or nothing. The biggest groups come first, and minions with no value (no address, no role) last.
- **Colour by**:
  - **Answers**: whether the minion answers `manage.status` now.
  - **Compliance**: its latest compliance check (in compliance, drifted, errors, not checked), with the server.
  - **Vulnerabilities**: critical, high, or neither, from the latest vulnerability scan.
  - **Salt version**: the same as the master, another release, or a major version behind.

Each tile has an icon and says its state when you point at it, besides its colour, and the legend counts the minions at each level. A bar under each group's name shows its share at a glance. Click a tile to open the minion.

The map reads what the Minions list reads (grains from the master's cache, `manage.status`, and the server's compliance and vulnerability records), so nothing runs on the minions.
