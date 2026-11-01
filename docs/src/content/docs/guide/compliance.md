---
title: Compliance
description: Find drift with a highstate dry-run and remediate it.
sidebar: { order: 2 }
---

**Compliance** dry-runs the highstate (`test=True`) across a target, then groups minions into:

- **In compliance**: nothing would change.
- **Drifted**: some states would change. You see the diffs.
- **Errors**: states failed to render or run.
- **No return**: the minion didn't answer.

**Remediate** opens [Run](/salt-shaker/guide/run/) with `state.apply` prefilled for just the drifted minions, so you can review and start it.

With the server, past checks are kept, so you can follow drift over time.
