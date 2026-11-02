---
title: Monitoring
description: Scrape fleet and job metrics with Prometheus.
sidebar: { order: 5 }
---

The server can expose a Prometheus endpoint at `/metrics`. It's off until you set a token, because it reveals key counts and schedule names:

```bash
METRICS_TOKEN=$(openssl rand -hex 24)
```

Prometheus then scrapes it with that token:

```yaml
scrape_configs:
  - job_name: salt-shaker
    scheme: https
    authorization:
      credentials: <METRICS_TOKEN>
    static_configs:
      - targets: ['salt.example.com']
```

Each scrape makes one `key.list_all` call to salt-api. Everything else is read from the job history the server already records, so nothing runs on minions.

## Metrics

All are gauges.

| Metric | Labels | |
| --- | --- | --- |
| `salt_shaker_info` | `version` | always 1 |
| `salt_shaker_master_up` | | 1 if salt-api answered this scrape |
| `salt_shaker_minion_keys` | `status`: accepted, pending, rejected, denied | minion keys on the master |
| `salt_shaker_compliance_minions` | `status`: ok, drift, error, noreturn | minions by result in the latest compliance check |
| `salt_shaker_compliance_last_check_timestamp_seconds` | | when that check started |
| `salt_shaker_jobs_24h` | | jobs started in the last 24 hours |
| `salt_shaker_job_returns_24h` | `result`: ok, failed | minion returns in the last 24 hours |
| `salt_shaker_schedule_enabled` | `schedule`, `kind` | 1 if the schedule is on |
| `salt_shaker_schedule_last_run_timestamp_seconds` | `schedule`, `kind` | last start, 0 if never |
| `salt_shaker_schedule_last_run_failed_minions` | `schedule`, `kind` | failed returns in its last run |
| `salt_shaker_schedule_last_run_error` | `schedule`, `kind` | 1 if the last run couldn't start |
| `salt_shaker_events_leader` | | 1 on the instance that records job history |

Compliance and job metrics come from job history. They're only complete while one instance reports `salt_shaker_events_leader 1`.

## Example alerts

```yaml
groups:
  - name: salt
    rules:
      - alert: SaltMasterDown
        expr: salt_shaker_master_up == 0
        for: 5m
      - alert: SaltKeysPending
        expr: salt_shaker_minion_keys{status="pending"} > 0
        for: 1h
      - alert: SaltDrift
        expr: salt_shaker_compliance_minions{status=~"drift|error"} > 0
      - alert: SaltComplianceStale
        expr: time() - salt_shaker_compliance_last_check_timestamp_seconds > 2 * 86400
      - alert: SaltScheduleFailing
        expr: salt_shaker_schedule_last_run_error == 1 or salt_shaker_schedule_last_run_failed_minions > 0
      - alert: SaltNoHistoryRecorder
        expr: max(salt_shaker_events_leader) == 0
        for: 5m
```
