---
title: Behind a reverse proxy
description: TLS, proxy headers and Server-Sent Events.
sidebar: { order: 3 }
---

Put TLS in front of Salt Shaker, for example with a load balancer, Traefik or nginx.

- Set `PUBLIC_URL` to the URL users open. Cookies and origin checks are based on it.
- Set `TRUST_PROXY=1`, so client IPs for rate limits and the audit log are taken from `X-Forwarded-For`.
- Turn off response buffering for `/api/salt/events`. It's a Server-Sent Events stream.

## nginx

```nginx
location / {
  proxy_pass http://127.0.0.1:8080;
  proxy_set_header Host $host;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  proxy_set_header X-Forwarded-Proto $scheme;
}

location /api/salt/events {
  proxy_pass http://127.0.0.1:8080;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  proxy_buffering off;
  proxy_read_timeout 1h;
}
```
