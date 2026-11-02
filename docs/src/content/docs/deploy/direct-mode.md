---
title: Direct mode
description: Run the UI as static files that sign in to salt-api directly.
sidebar: { order: 6 }
---

The UI also runs without the server, as static files that sign in to salt-api directly. Each user signs in with their own eauth credentials and gets their own eauth permissions.

1. Build the UI with `npm run build`, which writes `dist/`.
2. Serve `dist/` and proxy `/salt-api/` to salt-api, with response buffering off.

If the UI and salt-api are on different origins, build with `VITE_SALT_API_URL=https://master:8000` instead, and enable CORS on salt-api.

The UI finds out at startup whether a server is present.

:::note
Users, roles, the audit log and long-term job history are only available with the server.
:::
