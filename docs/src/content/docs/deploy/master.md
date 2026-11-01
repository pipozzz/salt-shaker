---
title: Prepare the master
description: Enable salt-api and create the service account Salt Shaker uses.
sidebar: { order: 1 }
---

Salt Shaker needs salt-api (`rest_cherrypy`) on the master and one dedicated account for the server.

```yaml
# /etc/salt/master.d/api.conf
rest_cherrypy:
  port: 8000
  ssl_crt: /etc/pki/tls/certs/salt-api.crt
  ssl_key: /etc/pki/tls/private/salt-api.key

# Salt 3006+ disables all netapi clients by default
netapi_enable_clients: [local, local_async, runner, runner_async, wheel]

external_auth:
  pam:
    salt-shaker:             # a dedicated local account, used only by the server
      - '.*'
      - '@wheel'
      - '@runner'
      - '@jobs'
```

Restart `salt-master` and `salt-api` after changing the config.

:::caution
The service account is as powerful as the most powerful role you hand out. Keep its password in a secret store, and don't use it for anything else.
:::

Salt Shaker needs **Salt 3006 or newer**.
