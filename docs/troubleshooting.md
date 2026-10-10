# Troubleshooting

Three tools tell you almost everything:

```sh
filarr-gate doctor          # one line per check, exit 1 when one fails (add --json for a program)
curl -s http://127.0.0.1:8443/health
```

and the **Log** screen of the management UI (or the files `journal/<day>.jsonl` of the state directory), which
records every request served, every exchange with Filarr and every gesture, without a token, a key or a row's
content.

Every refusal of the API is `{ "error": "…", "code": "…" }`: look the `code` up in
[the reference of codes](reference/errors.md). The message (`error`) is for people and is in French for now.

## The gate does not start

| what you see | why | what to do |
|---|---|---|
| `aucun jeton : lancez d'abord filarr-gate init --token flr_live_…` | no token yet | `filarr-gate init --token flr_live_…`, or `FILARR_GATE_TOKEN`, or open the management UI: the setup screen asks for it |
| `EADDRINUSE` on 8443 or 8787 | another program uses the port | `FILARR_GATE_PORT=9443` (or `--port` at `init`), `FILARR_GATE_ADMIN_PORT` for the UI |
| `une boîte noire tourne sur ce répertoire` at `init` | a gate already runs on this state directory | stop it first, or replace the token in its UI (**Settings**) |
| Docker: `EACCES` on `/data` | the image runs as the user `node`; a bind mount owned by root is not writable | use a named volume (`-v filarr-gate:/data`), or `chown 1000:1000` the host folder |
| `L'interface n'est pas construite : npm run build:ui` | a gate run from source without the UI built | `npm run build` (it builds the UI too) |
| `jeton refusé` in the log | Filarr refused the token at start | see `doctor`, then the link states below |

## The link with Filarr

`GET /health` returns `"link"`; the dashboard and `doctor` show it. While the link is down, the gate keeps
serving its last complete copy: your software keeps reading.

<!-- generated:link-states -->
| state | what it means | what to do |
|---|---|---|
| `no_token` | No token yet. | Give the gate its token (setup screen, `filarr-gate init`, or `FILARR_GATE_TOKEN`). |
| `connecting` | Starting, or reconnecting after a pause. | Nothing; it moves on by itself. |
| `live` | The live stream of changes is open: a change in Filarr reaches the gate in about a second. | Nothing. |
| `polling` | No live stream (Free plan, the Cloudflare variant, or the stream refused): the gate polls Filarr at the interval of its plan, and on push wake-ups. | Nothing. For faster updates without a stream, give Filarr a wake-up address (`/_filarr/notify`). |
| `offline` | Filarr cannot be reached. The gate keeps serving its last copy and retries with a growing delay. | Check the machine's network and DNS; `filarr-gate doctor` tests Filarr. |
| `limited` | Filarr limits this access (a `429`): the gate waits for `Retry-After` and keeps serving its copy. | See **Usage and limits** (management UI) and the plan's limits in Filarr. |
| `paused` | The access is paused in Filarr. | Reopen it in Filarr, **Settings › API access**. |
| `not_switched` | API access is not open yet for the Filarr account that created the access. | Nothing to do on the gate: it starts as soon as Filarr opens it. |
| `ip_forbidden` | Filarr refuses the IP address of this machine for this access (allowed addresses). | Add the machine's public address to the access in Filarr, or run the gate from an allowed address. |
| `revoked` | The access was revoked, or its token replaced: the gate erased its copy and its keys. | Give the gate a new token (a replaced token: the new one from Filarr). |
| `expired` | The access reached its expiry date: the gate erased its copy. | Create a new access in Filarr, or extend the expiry before it is reached next time. |
| `unknown_access` | Filarr does not know this token (mistyped, or from another Filarr server). | Copy the whole token again; check `FILARR_GATE_API_URL`. |
| `upgrade_required` | This version of Filarr Gate is too old for Filarr's API. | Update Filarr Gate. |
| `pending` | The token is a new identity waiting for a migration: only the access and the settings package answer. | Finish the migration in Filarr ("Erase and change the keys"), or abandon it. |
| `asleep` | A hosted box is asleep (payment, plan or policy). | See **Settings › API access** in Filarr. |
| `error` | Filarr refused something unexpected; `detail` and the log say what. | Run `filarr-gate doctor`. |
<!-- /generated:link-states -->

## A database is missing, or answers 503

- **Not in the list at all** (`base_not_found`, or absent from `/openapi.json`): the access does not open it.
  Check the access in Filarr (**Settings › API access**). A database just added to an access appears once Filarr has
  sealed its key and published its views, which happens on a device of the creator, unlocked.
- **Listed with "manifest missing"** on the **Databases** screen: its views are not published for this access
  yet. They are republished the next time its note is opened in Filarr.
- **`503` with `key_missing`**: Filarr changed the keys of the database (a new generation, for instance after
  another access was revoked) and the creator has not re-sealed them for this access. The creator opens Filarr
  (desktop, web or mobile), unlocked: the keys are re-sealed and the gate catches up within seconds. Until then the
  gate refuses to serve a partial copy; a database it already served keeps being served, with the header
  `X-Gate-Base-Status: missing_key`.
- **`503` with `base_loading`**: the first copy is being made. Large databases take a few seconds.
- **Relations give raw ids, a rollup is `null`, `unresolved` lists fields**: they point to a database that is
  not opened to this access. The gate never reads a database it was not given. Open that database to the access too.

## Your software is refused

| status | code | the usual cause |
|---|---|---|
| 401 | `key_missing` | no `Authorization: Bearer gk_…` header (some HTTP clients drop it on a redirect: call the final address) |
| 401 | `key_unknown` | a typo, or a revoked key |
| 403 | `forbidden` | the key does not open this database, view, query, SQL or MCP |
| 403 | `ip_forbidden` | the key only accepts some addresses. Behind a reverse proxy, every request seems to come from the proxy: set `FILARR_GATE_TRUST_PROXY` to the proxy's address |
| 403 | `origin_forbidden` | a web page calls the API and its origin is not in `FILARR_GATE_CORS_ORIGINS` (closed by default) |
| 403 | `key_paused`, `key_expired` | resume the key, or create a new one |
| 404 | `view_not_found` | slugs are fixed when the database is opened; a view created later gets its slug at the next publication. `GET /openapi.json` lists them |
| 429 | `key_rate` | the key's own rate limit; wait `Retry-After` seconds, or raise the key's limit |
| 429 | `api_rate`, `api_quota_*` | a limit of Filarr (see below); reads from the copy are never limited |

## Writes are refused

Writing needs four things, checked in this order; the first missing one gives its code:

1. the gate's `write` setting (`FILARR_GATE_WRITE=true`): otherwise `403 write_disabled`;
2. Filarr opens writing to the access (plan with API writes, writes switched on): otherwise
   `403 filarr_write_unavailable`;
3. the access has the database in **read and write**: otherwise `403 base_read_only`;
4. the app key has the create, update or delete right on that database: otherwise `403 forbidden`.

Then:

- `409 field_managed`, `409 rows_managed`: an external sync feeds this column, or the rows of this database (a
  mirror). Change the source, or make the column yours in Filarr.
- `409 key_missing`: the gate does not hold the key of the database's current generation. The creator opens
  Filarr, unlocked; writes resume. A write is never sealed under an older key.
- `429 api_quota_writes`: the account's commits of the day are used up, until 00:00 UTC. A request with 500
  rows is one commit: batch your writes.
- `503 filarr_unreachable`: nothing was written; try again.

## Webhooks do not arrive

- The gate must reach the address: from a Docker container, `localhost` is the container itself.
- Answer **2xx within 10 seconds**. Anything else (a redirect included: redirects are not followed) is a failure.
  The gate tries 8 times: at once, then after 5, 10, 20, 40, 80, 160 and 320 minutes (a `Retry-After` from your
  receiver is honoured when it is longer). Then it gives up and says so in the log.
- Waiting deliveries live in memory only (their bodies carry rows in clear): a restart drops them, and the log says
  how many.
- **Signature refused by your receiver**: compute it on the RAW body, before any JSON parsing, and compare
  `HMAC-SHA256(secret, t + "." + body)`; check your clock (5 minutes of tolerance). See
  [the webhook tutorial](tutorials/webhooks.md).
- The management UI offers the events `row.created`, `row.updated`, `row.deleted` and `gate.quota`. The gate also
  sends `file.filed`, `sync.done` and `sync.failed`, but only to webhooks that already carry these events (imported
  with a settings package): the UI cannot choose them yet.

## External syncs

Start with `filarr-gate sources list`: for each sync Filarr assigns to this gate, it says what blocks it.

- `extdb_key_missing`: give the key (`filarr-gate sources key <id> --stdin`, the **Sources** screen, the variable
  `FILARR_GATE_EXTDB_<ID>` it names, or `gate.toml`). A key given to the gate is encrypted under a key derived from
  the token: after replacing the token, give it again.
- `extdb_unsigned`: the definition was changed by someone other than the access creator, or the creator's key is
  not authenticated (an access created before the creator tag existed: replace its token in Filarr).
- `extdb_lease_held`: another process started with the same token runs this sync (two containers, for instance).
  Run one gate per token.
- `extdb_guard`: the safety stop. Too many rows would be marked or deleted at once; **nothing was written**. Check the
  source; to go on for this pass only, `filarr-gate sources run <id> --ack-guard <pass>` (the pass is in the
  question shown by `sources run`), or agree in Filarr.
- `extdb_conflict_burst`: too many new conflicts at once; check the direction and the row key. On a first pass,
  `--initial source` or `--initial filarr` settles it.
- **A row deleted in the source is still in Filarr**: disappearances are only seen at a FULL read, which happens
  every 24 hours or every 96 passes when the sync has a change marker (at every pass without one).
- **PostgreSQL or MySQL from the Cloudflare variant**: impossible (no TCP); use the Node or Docker gate.

All the sync codes: [reference/errors.md](reference/errors.md#states-of-an-external-sync).

## Files

- `files_not_linked`: link a deposit box to the access in Filarr (Pro plan and above).
- `creator_unauthenticated`: the access has no creator tag (created before revision 3) or the creator's key does
  not check out. In Filarr, desktop or web, replace the token of the access.
- `box_not_signed`: link the box again from Filarr, which signs it.
- `file_type_refused`: an executable or script, by extension or by its first bytes; refused before anything left.
- `box_full`: deposits wait to be filed; **open Filarr** on a device that files the box. Waiting does not help.

## Filarr's limits

The gate never counts its own reads. What Filarr counts (sync requests, downloaded volume, commits, files) and the
limits of each plan are read from Filarr: the **Usage and limits** screen of the management UI shows them (from
`GET /public/api-limits` and the `X-Filarr-Quota` header), and so does **Settings › API access** in Filarr. When a
limit is reached, the gate keeps serving its copy; only downloads, writes or deposits wait. See
[reference/limits.md](reference/limits.md).

## Refusals of Filarr, with their remedy

The codes of revision 3 (hosted box, files, external syncs) and the remedy Filarr attaches to each, read from the
vectors `boite-noire-v2-serveur` that Filarr's server is tested against:

<!-- generated:filarr-codes -->
| code | status | remedy | what happened | what to do |
|---|---|---|---|---|
| `reauth_required` | 401 | `reauthenticate` | Entrusting a database to the hosted box needs a fresh proof of identity. | Filarr asks for it on screen (password, two-factor code or passkey). |
| `reauth_failed` | 401 |  | The proof of identity was wrong. | Try again; after 10 tries in an hour, wait. |
| `api_tier_hosted` | 403 | `upgrade` | The hosted box needs the Pro plan or above. | A higher plan, or run the gate yourself. |
| `hosting_forbidden` | 403 |  | The organization forbids hosted boxes. | Ask an organization admin, or run the gate yourself. |
| `hosting_not_switched` | 409 |  | The hosted box is not open yet for this account. | Nothing to do; it opens account by account. |
| `consent_outdated` | 409 |  | The consent text changed since you accepted it. | Filarr shows the new text again; accept it to keep the database entrusted. |
| `host_key_unknown` | 409 |  | Your Filarr app does not know the hosted service's current key. | Update the Filarr app. |
| `hosting_billing_unavailable` | 409 | `manageBilling` | No Stripe subscription can carry the option for this payer. | Manage billing in Filarr, or bill the organization. |
| `hosting_exists` | 409 |  | This access is already hosted. | Nothing; use the migration screens to change where it runs. |
| `consent_required` | 409 |  | Adding a database to a hosted access needs a consent for that database first. | Accept the consent for it in Filarr, then add it. |
| `hosting_not_found` | 404 |  | This access is not hosted. | Nothing. |
| `migration_pending` | 409 |  | A migration of this access is already in progress. | Finish or abandon it in Filarr. |
| `migration_not_ready` | 409 |  | The new gate has not imported its settings package yet. | Start the new gate with its new token and wait for the import, then switch. |
| `hosting_too_large` | 413 |  | The databases to entrust are too large for a hosted box. | Entrust fewer databases, or run the gate yourself. |
| `hosting_asleep` | 403 | billing: `updatePayment`; tier: `upgrade`; policy: none; consent: none; service: none | The hosted box is asleep (payment, plan or policy). `remedy` says what wakes it up. | See **Settings › API access** in Filarr. |
| `hosted_origin_required` | 401 |  | A hosted box's token was presented outside the hosted service. | Nothing; this protects the token. |
| `api_access_pending` | 403 |  | A new identity waiting for a migration called something other than `self` or its import. | Finish the migration in Filarr. |
| `api_tier_files` | 403 | `upgrade` | Receiving files through the API needs the Pro plan or above. | A higher plan. |
| `files_not_switched` | 409 |  | Files through the API are not open yet for this account. | Nothing; it opens account by account. |
| `files_not_linked` | 409 |  | No deposit box is linked to the access. | Link a deposit box in Filarr. |
| `box_not_permanent` | 409 |  | The box linked to the access is not a permanent deposit box. | Link a permanent box (Filarr creates one for you). |
| `box_not_found` | 404 |  | The linked deposit box no longer exists. | Link another box in Filarr. |
| `deposit_not_found` | 404 |  | Filarr does not know this deposit. | Check the identifier. |
| `box_full` | 409 |  | Too many deposits wait to be filed in the box. | Open Filarr to file them. |
| `box_storage_full` | 413 |  | The deposits waiting in the box take too much space. | Open Filarr to file them. |
| `file_too_large` | 413 |  | The file is larger than Filarr accepts (`limit`). | Send a smaller file. |
| `api_quota_files` | 429 | `wait` (with `Retry-After`) | The account deposited as many files as its plan allows this month. | Wait for the next month. |
| `api_quota_file_bytes` | 429 | `wait` (with `Retry-After`) | The account deposited as many bytes of files as its plan allows this month. | Wait for the next month. |
| `ext_status_conflict` | 409 |  | Two writers published a sync's state at the same time. | Nothing. |
| `ext_queue_conflict` | 409 |  | Two writers published a sync's conflict queue at the same time. | Nothing. |
| `ext_resolve_full` | 409 |  | Too many decisions wait for the sync's runner. | Make sure the gate that runs the sync is running; it reads the decisions at its next pass. |
| `extdb_lease_held` | 409 | `wait` (with `Retry-After`) | Another process holds this sync's lease (two gates started with the same token). | Run one gate per token; stop the other instance. |
| `extdb_relay_off` | 409 |  | Web only: Filarr's relay for external databases is switched off. | Run the sync from the desktop app or a gate. |
<!-- /generated:filarr-codes -->

## Still stuck

Open an issue with the output of `filarr-gate doctor --json` and the lines of the log around the problem (neither
contains a token, a key or a row). A security problem goes through [SECURITY.md](../SECURITY.md), never a public issue.
