# Receive changes by webhook

[Lire en français](webhooks.fr.md)

**At the end**, when a row changes in Filarr (or through the API), the gate decrypts it and posts it, signed, to your
software; your receiver checks the signature and acts. You will have a receiver in Node and one in Python, a webhook
that fires only when a condition becomes true, and you will know what happens when your receiver is down.

**Plan:** every plan. Changes reach the gate live on Solo and above, at the polling interval on Free; the webhook
leaves as soon as the gate sees the change. The rows travel from the gate to your receiver, never through Filarr.

## 1. Start a receiver

Both receivers check the signature on the RAW body, refuse a timestamp more than five minutes away, answer `204` at
once, then act. They are in [examples/webhook-receiver](../../examples/webhook-receiver); the test suite starts each one,
makes a change in Filarr, checks the delivery is acted on, then sends a forged one and checks it is refused.

The signature check, in Node:

<!-- snippet: examples/webhook-receiver/receiver.mjs#verify -->
```js
/**
 * True when `header` (the `Filarr-Gate-Signature` header, `t=<seconds>,v1=<hex>`) signs
 * `rawBody` with `secret`, less than 5 minutes ago: v1 = HMAC-SHA256(secret, t + "." + body).
 */
function verifySignature(secret, rawBody, header, now = Math.floor(Date.now() / 1000)) {
  const parts = Object.fromEntries(String(header ?? '').split(',').map((p) => p.trim().split('=', 2)));
  const t = Number(parts.t);
  if (!Number.isInteger(t) || Math.abs(now - t) > 300) return false;
  if (!/^[0-9a-f]{64}$/.test(parts.v1 ?? '')) return false;
  const expected = createHmac('sha256', secret).update(`${t}.${rawBody}`).digest();
  return timingSafeEqual(expected, Buffer.from(parts.v1, 'hex'));
}
```

in Python:

<!-- snippet: examples/webhook-receiver/receiver.py#verify -->
```python
def verify_signature(secret: str, raw_body: bytes, header: str, now: int | None = None) -> bool:
    """True when `header` (`Filarr-Gate-Signature: t=<seconds>,v1=<hex>`) signs `raw_body`
    with `secret`, less than 5 minutes ago: v1 = HMAC-SHA256(secret, t + "." + body)."""
    parts = dict(p.strip().split("=", 1) for p in (header or "").split(",") if "=" in p)
    try:
        t = int(parts.get("t", ""))
    except ValueError:
        return False
    if abs((now if now is not None else int(time.time())) - t) > 300:
        return False
    expected = hmac.new(secret.encode(), f"{t}.".encode() + raw_body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, parts.get("v1", ""))
```

What each one does with an event:

<!-- snippet: examples/webhook-receiver/receiver.mjs#handle -->
```js
/** What to do with each event (here: one line on the console). */
function handle(event) {
  switch (event.event) {
    case 'row.created':
    case 'row.deleted':
      console.log(`${event.event} ${event.base} ${event.row.id}`);
      break;
    case 'row.updated':
      console.log(`${event.event} ${event.base} ${event.row.id} changed: ${event.changed.join(', ')}`);
      break;
    default:
      console.log(`${event.event}`);
  }
}
```

Start one (the secret comes at the next step; restart it then):

```sh
WEBHOOK_SECRET=whsec_… PORT=8000 node examples/webhook-receiver/receiver.mjs
WEBHOOK_SECRET=whsec_… PORT=8000 python examples/webhook-receiver/receiver.py
```

The gate must reach it: from a Docker container, `localhost` is the container itself; give an address the gate's
machine can reach (in production, HTTPS).

## 2. Create the webhook

In the management UI, **Webhooks › New webhook**:

- **Name**: what it is for ("Billing: new order").
- **Target URL**: `http://127.0.0.1:8000/filarr` here.
- **Events**: Row added (`row.created`), Row changed (`row.updated`), Row deleted (`row.deleted`), Filarr quota
  notice (`gate.quota`).
- **Database**, and optionally a **View**: only the rows of that view trigger it.
- **Condition** (optional): SQL on the row's JSON fields, evaluated by Filarr's SQL engine: `statut = 'Perdu'`,
  `montant > 1000`, `ville IN ('Lyon', 'Paris')`.
- **Only when the condition BECOMES true**: for `row.updated`, the webhook fires when the row enters the condition,
  not at every later change ("status becomes Lost").
- **Fields sent** (empty: the whole row), and **Relations to resolve**: a relation field then carries the linked
  rows themselves (when their database is opened to the access), not only their ids.

**Create the webhook** shows the **signing secret** (`whsec_…`) once: give it to your receiver
(`WEBHOOK_SECRET`) and restart it. **Send a test** posts a `ping` event at once.

## 3. Watch a delivery

Change a row of that database in Filarr. The receiver prints:

```text
row.updated clients r_initech changed: ville
```

The request it received:

```http
POST /filarr HTTP/1.1
Content-Type: application/json
User-Agent: filarr-gate-webhook
Filarr-Gate-Event: row.updated
Filarr-Gate-Delivery: dlv_mgk2z1a4e3f9c2b71d
Filarr-Gate-Signature: t=1760074123,v1=5d41402abc4b2a76b9719d911017c592…

{"id":"dlv_mgk2z1a4e3f9c2b71d","event":"row.updated","base":"clients","version":15,"origin":"filarr",
 "changed":["ville"],"before":{"ville":"Lille"},"row":{"id":"r_initech","nom":"Initech","ville":"Roubaix", …}}
```

| field | |
|---|---|
| `id` | the delivery's id, the same at every retry: use it to ignore a delivery you already processed |
| `event` | `row.created`, `row.updated`, `row.deleted`, `gate.quota`, `ping` (and `file.filed`, `sync.done`, `sync.failed`: below) |
| `base`, `view` | the slugs |
| `version` | the version of the database after the change |
| `origin` | `filarr` (written in Filarr) or `gate` (written through this gate's API) |
| `changed`, `before` | `row.updated` only: the fields that changed, and their values before |
| `row` | the row, as the API gives it (only the fields sent) |

`gate.quota` carries `{ name, pct, at }` when Filarr warns at 80 % and 100 % of a limit.

## When the receiver is down

- Anything but a `2xx` within **10 seconds** is a failure (redirects are not followed).
- The gate tries **8 times**: at once, then after 5, 10, 20, 40, 80, 160 and 320 minutes, about ten hours and a half in
  all; a longer `Retry-After` from your receiver is honoured. Then it gives up, and the log says so.
- Waiting deliveries live **in memory only** (their bodies carry rows in clear): a restart of the gate drops them, and
  the log says how many. For a reliable copy, reconcile from time to time with `GET /v1/<base>?since=<version>`.
- The **Webhooks** screen shows the last deliveries of each webhook: status, duration, attempt, next retry.

## Rotate the secret

**Renew the secret** (on the webhook) shows a new one; the old one stops signing at once. Give the new one to the
receiver right away.

## Events of files and syncs

The gate also sends `file.filed` (a file deposited by this gate was filed by the Filarr app: `file: { id, status,
depositedAt, filedAt, sizeBytes, source }`, never where nor under which name) and `sync.done` / `sync.failed` (a pass
of an external sync: `defId`, `name`, `base`, `state`, `code`, `counts`, `queue`). The management UI cannot choose
these events yet: only webhooks that carry them (imported from another gate's settings package) receive them.

## Next

- [A static site rebuilt on each change](../../examples/static-site) (webhook + rebuild).
- Signature, retries, every event: [reference/webhooks.md](../reference/webhooks.md).

## If it does not work

- Nothing arrives: the **Webhooks** screen shows each attempt and its error (`fetch failed`: the address is not
  reachable from the gate).
- Your receiver refuses every delivery: compute the HMAC on the raw bytes, before parsing; compare `t + "." + body`;
  check the machine's clock.
- More: [troubleshooting](../troubleshooting.md#webhooks-do-not-arrive).
