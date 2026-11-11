---
title: API and tokens
description: Call Salt Shaker from scripts and CI with a personal API token.
---

Everything the web UI does goes through Salt Shaker's HTTP API, and scripts or CI jobs can use it too, with a **personal API token**.

## Tokens

On **API tokens**, name a token after the job that uses it, pick when it expires (30 days, 90 days, a year or never) and **Make a token**. It's shown once; Salt Shaker keeps only a hash. **Revoke** stops it right away.

A token acts as you: your role, the minions you're [limited to](/salt-shaker/reference/roles/#limiting-what-someone-can-run-on), the [approvals](/salt-shaker/guide/changes/#approvals) your commands need, and the [audit log](/salt-shaker/guide/users-audit/#audit-log) shows what it did under your name. It stops working when your account is disabled or loses its role. A token can't be used to make or list tokens; that takes signing in.

Send it as a bearer token:

```bash
curl -s https://salt.example.com/api/me -H "Authorization: Bearer $SALT_SHAKER_TOKEN"
```

## Examples

Run something, as on [Run](/salt-shaker/guide/run/) (a lowstate, as salt-api takes it):

```bash
curl -s https://salt.example.com/api/salt \
  -H "Authorization: Bearer $SALT_SHAKER_TOKEN" -H "Content-Type: application/json" \
  -d '{"client":"local","tgt":"web-*","fun":"state.apply","kwarg":{"test":true}}'
```

Roll a change out in batches, from a deploy pipeline (see [Changes](/salt-shaker/guide/changes/)):

```bash
curl -s https://salt.example.com/api/changes \
  -H "Authorization: Bearer $SALT_SHAKER_TOKEN" -H "Content-Type: application/json" \
  -d '{"reason":"Deploy '"$CI_COMMIT_SHORT_SHA"'","target":"web-*","targetType":"glob","fun":"state.apply","arg":["webserver"],"kwarg":{},"batchSize":"25%","maxFailures":0}'
```

It answers with the change (`{"change":{"id":42,"status":"queued",…}}`); `GET /api/changes/42` reports its status (`running`, `done`, `stopped`, `failed`, or `pending` while it waits for approval) and each minion's outcome.

Read the vulnerability report, or export it as CSV:

```bash
curl -s "https://salt.example.com/api/vulns?wait=0" -H "Authorization: Bearer $SALT_SHAKER_TOKEN"
curl -s "https://salt.example.com/api/vulns/export?severity=critical,high&fix=1" -H "Authorization: Bearer $SALT_SHAKER_TOKEN" -o vulns.csv
```

## Endpoints

| Endpoint | What it does |
| --- | --- |
| `GET /api/me` | who the token belongs to, their role and limit |
| `POST /api/salt` | one salt-api lowstate (`local`, `local_async`, `runner`, `wheel`), checked against your role and limit |
| `GET /api/history/jobs`, `GET /api/history/jobs/:jid` | the job history, and one job with every minion's return |
| `POST /api/changes`, `GET /api/changes/:id`, `POST /api/changes/:id/stop` | batched rollouts and approvals |
| `GET /api/vulns`, `GET /api/vulns/export`, `GET /api/vulns/packages?q=` | the vulnerability report, its CSV, and where a package is installed |
| `GET /api/history/compliance/minions`, `GET /api/history/updates/minions` | each minion's latest compliance check and patch scan |
| `GET /api/audit`, `GET /api/audit/export` | the audit log (admins and operators) |

Errors come back as JSON, `{"error": "…"}`, with 401 for a missing, unknown or expired token and 403 for what your role or limit doesn't allow.
