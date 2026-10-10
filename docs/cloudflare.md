# Filarr Gate on your Cloudflare account

The same black box as the Node version, in a **Worker** and one **Durable Object** of YOUR account. Filarr never holds
the token: it is a secret of your Worker.

## Deploy

With the button in the README, or by hand from a clone of this repository:

```sh
npm ci
npm run build                                   # the management UI (packages/cli/dist/ui), served by the Worker
npx wrangler deploy                             # wrangler.jsonc at the root of the repository
npx wrangler secret put FILARR_GATE_TOKEN       # the token shown once by Filarr
npx wrangler secret put FILARR_GATE_ADMIN_PASSWORD
```

The local API is the Worker's address (`https://filarr-gate.<account>.workers.dev`, or your own domain); the
management UI is under `/admin/`. App keys are created there.

## How it runs

- One Durable Object (SQLite-backed, the only kind on the Free plan) holds the state, the encrypted block cache, the
  log and the encrypted state of the syncs, in its own storage.
- No loop: the object sleeps between **alarms**. Every `FILARR_GATE_POLL_SECONDS` (300 s at least) it polls Filarr; a
  sync, a webhook retry or a planned pass brings the alarm forward.
- **Push wake-ups**: give `https://<your worker>/_filarr/notify` as the access's wake-up address in Filarr. Filarr
  signs each wake-up with a key derived from the token (`A_notify`); the gate checks the signature and a 5-minute
  window, then re-reads. With it, a change in Filarr reaches the gate within seconds instead of at the next poll.
- External databases: the HTTPS connectors (D1, Supabase, Airtable, Google Sheets, Notion, CSV/JSON by URL).
  PostgreSQL and MySQL need TCP: use the Node version or Docker for them. Their keys are given in the UI (stored
  encrypted) or as Worker secrets `FILARR_GATE_EXTDB_<ID>`.

## Settings

Worker variables (`vars` in `wrangler.jsonc`, or the dashboard) are the environment variables of the README and are
shown locked in the UI. Listening, TLS and cache settings do not apply here. Two extra ones:

| variable | |
|---|---|
| `FILARR_GATE_PUBLIC_URL` | the address to show and give out, when it is not the one requests arrive on |
| `FILARR_GATE_LOG_LEVEL` | `debug`, `info`, `warn`, `error` (Workers logs) |

## Try it locally

`wrangler dev` runs the Worker and the Durable Object on your machine (nothing goes to Cloudflare):

```sh
npm run mock-filarr       # in another terminal: an in-memory Filarr on 127.0.0.1:8790 and a token
npx wrangler dev --local --var FILARR_GATE_API_URL:http://127.0.0.1:8790 \
  --var FILARR_GATE_TOKEN:flr_live_… --var FILARR_GATE_ADMIN_PASSWORD:'a long password'
```

`test/cloudflare.test.ts` does exactly this in the test suite (first copy, keys, rows, writes, a signed push wake-up,
the state surviving a restart).

## Limits to know

- One Worker, one gate, one token. Several gates: several Workers (change `name` in `wrangler.jsonc`).
- A Worker request body is limited by your plan (100 MB on Free and Pro): that is also the largest file the slot takes.
- Webhook retries and passes that would run while the object sleeps run at the next alarm.
