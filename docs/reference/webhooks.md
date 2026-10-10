# Webhooks

[Lire en français](webhooks.fr.md)

Tutorial: [receive changes by webhook](../tutorials/webhooks.md), with receivers in Node and Python.

## A delivery

```http
POST <your address>
Content-Type: application/json
User-Agent: filarr-gate-webhook
Filarr-Gate-Event: row.updated
Filarr-Gate-Delivery: dlv_…
Filarr-Gate-Signature: t=<unix seconds>,v1=<hex>
```

`v1 = HMAC-SHA256(secret, t + "." + raw body)`, hex. Verify it on the **raw bytes** of the body, before parsing, with a
constant-time comparison, and refuse a `t` more than 300 seconds away from your clock.

## Events

| event | fires when | body (besides `id` and `event`) |
|---|---|---|
| `row.created` | a row appears in the database (or the view) and passes the condition | `base`, `view`?, `version`, `origin`, `row` |
| `row.updated` | a row changes and passes the condition (with "becomes true": only when it did not pass before) | the same, plus `changed` (field names) and `before` (their old values) |
| `row.deleted` | a row is deleted | `base`, `view`?, `version`, `origin`, `row` (as it was) |
| `gate.quota` | Filarr warns at 80 % and 100 % of a limit | `name`, `pct`, `at` |
| `ping` | **Send a test** | `webhook`, `at` |
| `file.filed` | a file deposited by this gate was filed by the Filarr app (not sent for `rejected` or `expired`) | `file: { id, depositId, status, depositedAt, filedAt, sizeBytes, source }` |
| `sync.done`, `sync.failed` | a pass of an external sync ended: `sync.done` when its state is `ok`, `sync.failed` otherwise (an error, a safety stop, a blocked sync) | `defId`, `name`, `base`, `state`, `code`, `counts`, `queue`, `at` |

`origin` is `filarr` (written in Filarr) or `gate` (written through this gate). `id` is the delivery's id, the same at
each retry: use it to ignore a delivery already processed.

The management UI and its API offer `row.created`, `row.updated`, `row.deleted` and `gate.quota`. `file.filed`,
`sync.done` and `sync.failed` are delivered only to webhooks that carry them, which today means webhooks imported with
a settings package.

## What a webhook selects

| setting | |
|---|---|
| database, view | the rows of that database; with a view, only those its filters keep |
| condition | SQL on the row's JSON fields, evaluated by Filarr's SQL engine (`montant > 1000 AND statut = 'Client'`); a row for which it errors does not pass |
| becomes true | for `row.updated`: only when the row passes now and did not before |
| fields | the fields sent (`id` always); empty: the whole row |
| relations to resolve | relation fields whose linked rows are sent whole (when their database is opened to the access) |

## Retries

- A success is a `2xx` within 10 seconds. Redirects are not followed.
- 8 attempts: at once, then after 5, 10, 20, 40, 80, 160 and 320 minutes (about ten hours and a half in all); a longer
  `Retry-After` from the receiver is honoured. Then the delivery is abandoned and the log says so.
- Pending deliveries live in memory only: a restart abandons them (the log says how many).
- The last 200 deliveries of each webhook (status, duration, attempt, error, next retry) are on the **Webhooks**
  screen; their bodies stay in memory.

## Secrets

Shown once at creation (`whsec_…`); **renew** shows a new one and the old one stops signing at once. Secrets are kept in
the gate's state (they travel in a settings package, so receivers keep verifying after a migration).
