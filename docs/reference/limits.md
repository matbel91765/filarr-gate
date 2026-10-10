# Limits

No number of a plan is written in this documentation: the plans and their limits live at Filarr, change there, and are
read from there. This page says **what** is counted, **where** to read the figures, and **how the gate behaves** at each
limit.

## Where to read the figures

- **Filarr's pricing page**, and **Settings › API access** in the Filarr app (with this month's usage and alerts at
  80 % and 100 %).
- The gate's **Usage and limits** screen: it reads the table of plans from Filarr (`GET /public/api-limits`, public,
  cached an hour) and the counters of each answer (`X-Filarr-Quota: sync=<n>/<max>; bytes=<n>/<max>; writes=<n>/<max>`
  and `RateLimit-*`).
- `filarr-gate doctor` (one line per counter) and the metrics `filarr_gate_quota_used` and `filarr_gate_quota_max`.

```sh
curl -s https://api.filarr.com/public/api-limits
```

## What Filarr counts

Only what goes through Filarr. **Reads served by the gate from its copy are never counted, never limited by Filarr.**

| counted | per | |
|---|---|---|
| sync requests | account, month | every request a gate sends to Filarr |
| downloaded volume | account, month | the bytes of blocks and heads |
| writes | account, day (UTC) | each accepted commit, whatever the number of rows in it |
| request rate | access, minute | |
| files deposited, their volume | account, month (UTC) | Pro and above |
| hosted calls | hosted box, month | the hosted box only (coming soon) |

The plan also sets: how many accesses, how many databases per access, writes or not, live changes or polling, the
retention of the access's log at Filarr, allowed addresses, files, scheduled external syncs, the hosted option.

## How the gate behaves

The gate keeps serving its last copy through every limit: your software keeps reading.

| Filarr answers | the gate |
|---|---|
| `429 api_rate` | pauses every exchange with Filarr until `Retry-After`; link `limited` |
| `429 api_poll_interval` (Free) | holds that database until `Retry-After`; it never polls faster than the plan nor `poll_seconds` |
| `429 api_quota_sync` | holds that database (heads and changes at most every 900 seconds); the live stream closes and the gate polls every 900 seconds until the next month |
| `429 api_quota_bytes` | stops downloading blocks until the 1st of the month (UTC); keeps serving what it has |
| `429 api_quota_writes` | refuses the write to your software with `429` and `Retry-After` (until 00:00 UTC) |
| `429 api_quota_files`, `api_quota_file_bytes` | refuses the deposit with `429` and `Retry-After` (until the 1st, UTC) |
| a stream refused for the plan (`api_tier_stream`) | polls instead |
| a `quota` message (80 %, 100 %) | logs it, shows it, and fires the `gate.quota` webhooks |

## Limits of the gate itself

These are the gate's own, not a plan's:

| | |
|---|---|
| an app key's rate | set per key (the default is shown in the key form) |
| polling without a stream | never below 300 seconds |
| rows per create request | 500 (one commit) |
| rows per page | 1000 |
| SQL | 64 KiB of query, 10,000 rows returned |
| a file | never above 100 MiB, lower if Filarr or `files_max_bytes` says so |
| an external sync | 100,000 rows per definition, two passes at a time |

## Write less, count less

A commit is counted once whatever its size: create rows in batches (one request with an array), and let a sync write
its pass in one commit (it does). Watch the gate's counters with Prometheus, and the alerts in Filarr.
