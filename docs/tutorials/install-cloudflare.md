# Install the gate on your Cloudflare account

**At the end** you will have Filarr Gate running as a Worker on YOUR Cloudflare account: its API at
`https://filarr-gate.<your-account>.workers.dev` (or your own domain), its management UI under `/admin/`, the token
a secret of your Worker that neither Filarr nor anyone else can read, and, if your Filarr offers it, Filarr waking it
up within seconds of a change.

**Plan:** every Filarr plan. Cloudflare's Workers Free plan is enough to start (one Worker and one SQLite-backed
Durable Object); a request body is limited by your Cloudflare plan, which bounds the largest file the gate can take.

## How it differs from the Node version

| | Node, Docker | Cloudflare |
|---|---|---|
| changes from Filarr | live stream, about a second | no stream: the Durable Object sleeps between **alarms** and polls every `FILARR_GATE_POLL_SECONDS` (300 s at least); with a **wake-up address**, Filarr wakes it within seconds |
| external syncs | every connector | HTTPS connectors only (D1, Supabase, Airtable, Google Sheets, Notion, CSV or JSON); **not PostgreSQL nor MySQL** (no TCP) |
| settings | environment, `gate.toml`, UI | Worker variables (shown locked in the UI), and the UI |
| listening, TLS, cache | your choice | fixed: Cloudflare serves HTTPS; the encrypted blocks live in the object's storage |
| one gate | one process per token | one Worker per token (deploy another Worker, another `name`, for another token) |

## Before you start

- A Cloudflare account, and Node.js 20 or newer.
- The token `flr_live_…` ([open a database to an API](open-a-database.md)).

## 1. Deploy

**With the button** (it forks this repository into your GitHub account and deploys it):

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/matbel91765/filarr-gate)

The form asks for the two secrets of step 2.

**Or by hand**, from a clone:

```sh
git clone https://github.com/matbel91765/filarr-gate.git
cd filarr-gate
npm ci
npm run build                 # the management UI, served by the Worker
npx wrangler login
npx wrangler deploy           # reads wrangler.jsonc at the root of the repository
```

`wrangler deploy` prints the Worker's address: `https://filarr-gate.<your-account>.workers.dev`.

## 2. The two secrets

```sh
npx wrangler secret put FILARR_GATE_TOKEN            # paste the token
npx wrangler secret put FILARR_GATE_ADMIN_PASSWORD   # the management password, ten characters or more
```

They are secrets of YOUR account: encrypted by Cloudflare, never shown again, readable by your Worker only.

## 3. Open the management UI

Go to `https://filarr-gate.<your-account>.workers.dev/admin/` and sign in with the password. The first copy of the
databases is made when the object first wakes up: until then the API answers `503` (`base_loading`).

**Protect it further** (recommended): put the `/admin/*` path behind Cloudflare Access (Zero Trust › Access ›
Applications, a self-hosted application on that path, your company's identity provider). Whoever enters the UI reads
the data in clear.

## 4. An app key, a first call

In the UI: **App keys › New key**. Then:

```sh
curl -s -H "Authorization: Bearer gk_…" "https://filarr-gate.<your-account>.workers.dev/v1/clients?limit=2"
```

The command line `filarr-gate` can drive this gate too, from your computer:

```sh
filarr-gate keys list --remote https://filarr-gate.<your-account>.workers.dev --admin-password '…'
```

## 5. Changes within seconds: the wake-up address

Without a stream, the gate polls Filarr every five minutes. To make a change in Filarr reach it within seconds, give
the access this **wake-up address** in Filarr (**Settings › API access**, field "Wake-up address", in Filarr versions
that offer it):

```text
https://filarr-gate.<your-account>.workers.dev/_filarr/notify
```

At each change, Filarr posts to it a short message signed with a key derived from the token: no content, just
"read again". The gate checks the signature and a five-minute window, answers `202`, and re-reads through its usual
routes. An access created before wake-ups existed must have its token replaced first (Filarr says so).

## Settings

Worker variables (`vars` in `wrangler.jsonc`, or the Cloudflare dashboard) are the environment variables of the
[configuration](../reference/configuration.md), and appear locked in the UI. For example:

```jsonc
// wrangler.jsonc
"vars": {
  "FILARR_GATE_WRITE": "true",
  "FILARR_GATE_CORS_ORIGINS": "https://shop.example.com",
  "FILARR_GATE_PUBLIC_URL": "https://gate.example.com"
}
```

`FILARR_GATE_PUBLIC_URL` is the address the UI shows and gives out when you put the Worker behind your own domain
(Workers › your Worker › Settings › Domains & Routes).

## Try it locally first

`wrangler dev` runs the Worker and its Durable Object on your machine; nothing goes to Cloudflare:

```sh
npm run mock-filarr          # in another terminal: an in-memory Filarr and its token
npx wrangler dev --local --var FILARR_GATE_API_URL:http://127.0.0.1:8790 \
  --var FILARR_GATE_TOKEN:flr_live_… --var FILARR_GATE_ADMIN_PASSWORD:'a long password'
```

The test suite does exactly this (`test/cloudflare.test.ts`): first copy, keys, rows, writes, a signed wake-up, the
state surviving a restart.

## What stays on your account

The Durable Object keeps, in its own storage: the state (fingerprints of the app keys, webhook secrets, settings),
the encrypted blocks as Filarr stores them, the local log, and the encrypted state of the syncs. The decrypted rows
live in memory only, while the object is awake. The repository's `wrangler.jsonc` switches Workers Logs on
(`observability`): they receive the gate's console lines (paths, codes, durations; never a token, a key or a row) on
YOUR account. Turn it off there if you prefer.

## Next

- [Call the API](first-calls.md), [receive webhooks](webhooks.md).
- [Sync a Cloudflare D1 database](sync-d1.md): the gate on your account, the D1 key in your Worker.

## If it does not work

- `503 base_loading` for long: open `/admin/` (it wakes the object) and look at the **Dashboard**; `/health` gives
  the link state.
- No wake-up: check the address ends with `/_filarr/notify`; the **Log** screen shows each wake-up received, or
  `réveil refusé` with the reason (signature, time window).
- More: [troubleshooting](../troubleshooting.md).
