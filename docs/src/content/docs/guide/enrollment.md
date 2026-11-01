---
title: Enrollment
description: Accept minion keys and bootstrap new minions.
sidebar: { order: 4 }
---

![Enrollment](../../../../screenshots/enrollment.png)

**Enrollment** lists pending, accepted, rejected and denied keys. Denied keys belong to a minion id that already has a different accepted key. Check a key's fingerprint before you accept or reject it.

It also generates bootstrap commands for new minions. With **pre-seeded keys**, the key pair is generated on the master and accepted in advance, so the new minion is trusted on first contact.

:::caution
Pre-seeded enrollment shows the minion's private key once. Copy it to the minion over a trusted channel.
:::

Managing keys needs the **admin** role.
