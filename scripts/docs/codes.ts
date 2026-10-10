/**
 * Les codes qu'un utilisateur de Filarr Gate peut rencontrer, et ce qu'il faut faire pour chacun
 * (textes en anglais : la référence du dépôt public).
 *
 * Les LISTES viennent du code et des vecteurs (voir `scan.ts`) : ce fichier ne tient que
 * l'explication de chaque code. `npm run docs:check` échoue quand le code connaît un code qui
 * n'est pas expliqué ici, ou quand ce fichier explique un code que le code n'a plus.
 */

export interface CodeText {
  /** Ce qui s'est passé, en une ou deux phrases. */
  what: string;
  /** Que faire. */
  fix: string;
}

/**
 * Les codes de l'API LOCALE de la boîte (et de son API de gestion, marqués « Admin »), par code.
 * Quand un code a deux sens, `byStatus` explique chacun.
 */
export const LOCAL_CODES: Record<string, CodeText & { byStatus?: Record<number, CodeText> }> = {
  aborted: { what: 'Library only: `openGate()` was cancelled through its `signal`.', fix: 'Nothing to fix; open again when you need it.' },
  bad_body: {
    what: 'The JSON body is not what the route expects: an object for one row, an array of objects for several, never an empty array.',
    fix: 'Send `{ "field": value, … }`, or `[{ … }, { … }]` to create several rows at once.',
  },
  bad_cursor: { what: '`cursor` is not a value the gate gave out.', fix: 'Pass the `next` of the previous page exactly as received.' },
  bad_filter: {
    what: 'A query parameter is neither `field=value` nor `field[op]=value`, or the operator is unknown. In the management API, also a webhook condition that does not parse.',
    fix: 'Use one of `eq`, `ne`, `lt`, `lte`, `gt`, `gte`, `contains`, `in`, `empty`. Reserved parameters are `limit`, `cursor`, `fields`, `sort`, `q` and `since`.',
  },
  bad_ip: { what: 'Admin: an allowed address of an app key is neither an IP address nor a CIDR range.', fix: 'Write `203.0.113.7` or `10.0.4.0/24`.' },
  bad_json: { what: 'The body is not valid JSON.', fix: 'Check the quoting, and send `Content-Type: application/json`.' },
  bad_limit: { what: '`limit` is not a whole number of at least 1.', fix: 'Pass a number from 1 to 1000 (a larger number is served as 1000).' },
  bad_multipart: { what: 'The `multipart/form-data` body of a file deposit cannot be read.', fix: 'Let your HTTP library build the multipart body (with a `file` part); do not set the boundary by hand.' },
  bad_package: { what: 'The file given to `filarr-gate import` (or `init --import`) is not a Filarr Gate settings package.', fix: 'Use the file written by `filarr-gate export`, unchanged.' },
  bad_path: {
    what: 'The URL path cannot be decoded, or the `path` requested for a file is longer than 1024 characters.',
    fix: 'Percent-encode the path segments; shorten the requested path.',
  },
  bad_request: { what: 'Admin: the management API refused the request (the message says why).', fix: 'Read `error`, correct the field it names, and try again.' },
  bad_since: { what: '`since` is not a version number.', fix: 'Pass the `version` of a page you already read (`since=1042` or `since=v1042`).' },
  bad_tags: { what: 'More than 10 tags, or a tag longer than 40 characters, on a file deposit.', fix: 'Send 10 tags at most, 40 characters each.' },
  bad_value: { what: 'A value does not fit the column it is written to (a text for a number, a malformed date…). `field` names the field.', fix: 'Send the JSON type the field expects; `GET /openapi.json` lists each field with its type.' },
  bad_password: { what: 'Admin: the management password is wrong.', fix: 'Type it again. After 5 failures in a minute the gate answers `too_many_attempts` for a minute.' },
  bad_response: { what: 'Filarr accepted a file deposit without returning its identifier.', fix: 'Try again; if it persists, run `filarr-gate doctor` and report it.' },
  base_not_found: { what: 'No database opened to this access has this slug.', fix: 'Check the address: `GET /openapi.json`, or the **Databases** screen of the management UI, lists the slugs.' },
  base_read_only: { what: 'Filarr opened this database to the access for reading only (right `r`).', fix: 'In Filarr, open the database to the access in read and write.' },
  body_too_large: { what: 'The body is larger than the gate accepts (4 MiB for JSON; 8 KiB for a wake-up).', fix: 'Send fewer rows per request (500 at most), or split the work.' },
  box_full: {
    what: 'The deposit box linked to the access already holds as many deposits waiting to be filed as Filarr allows. Nothing was sent.',
    fix: 'Open Filarr on a device that files the box (desktop or web), or file the waiting deposits by hand. Waiting does not help: someone must open Filarr.',
  },
  box_not_signed: { what: 'The deposit box linked to the access is not signed by the access creator: the gate refuses to seal files for it.', fix: 'Link the box again from Filarr (desktop or web), which signs it.' },
  confirm_required: { what: 'Admin: forgetting the machine needs the confirmation word.', fix: 'Type the word the screen asks for.' },
  creator_unauthenticated: {
    what: 'The gate could not authenticate the access creator\'s key, so it refuses signed objects (deposit boxes, sync definitions, migrations). Most often the access was created before revision 3 and has no creator tag.',
    fix: 'In Filarr (desktop or web), **Settings › API access**, replace the token of this access, then give the new token to the gate.',
  },
  csrf: { what: 'Admin: a write to the management API without the `X-Gate-Admin: 1` header.', fix: 'Use the management UI or the `filarr-gate` command; a script must send the header.' },
  deposit_failed: { what: 'The file deposit failed for an unexpected reason (the message says which).', fix: 'Try again; see the gate\'s log.' },
  deposit_not_found: { what: 'No deposit of this gate has this identifier.', fix: 'Use the `id` (`dp_…`) returned by `POST /v1/files`.' },
  field_managed: {
    what: 'This column is fed by an external source (the sync writes it, `in` direction): the local API does not write it.',
    fix: 'Change the value in the source; or, in Filarr, make the column yours (detach it from the sync).',
  },
  field_read_only: { what: 'This field is computed in Filarr (formula, rollup, creation or update time, back-link) and is never written.', fix: 'Remove it from the body; write the columns it is computed from.' },
  file_required: { what: 'A multipart deposit without a `file` part.', fix: 'Name the part `file`, or send the raw bytes with `?name=` (or an `X-File-Name` header).' },
  file_too_large: { what: 'The file is larger than the gate\'s limit or Filarr\'s (`limit` gives the size allowed, in bytes). Nothing was sent.', fix: 'Send a smaller file, or raise `files_max_bytes` (never above the limit Filarr gives).' },
  file_type_refused: {
    what: 'The gate\'s filter refused the file before anything left: an extension on the deny list (or missing from the allow list), or an executable signature (`MZ`, ELF, Mach-O, `#!`). `reason` and `detail` say which.',
    fix: 'Send a document, not a program; or change `files_deny` / `files_allow` in the gate\'s settings.',
  },
  filarr_unreachable: { what: 'Filarr could not be reached: the write or deposit was NOT done.', fix: 'Try again later; reads keep being served from the copy meanwhile.' },
  filarr_write_unavailable: {
    what: 'Filarr does not open writing to this access: the plan has no API writes, or API writes are not switched on yet for the account.',
    fix: 'See **Settings › API access** in Filarr, and the plan of the account that created the access.',
  },
  files_not_linked: { what: 'No deposit box is linked to this access, so there is nowhere to deposit files.', fix: 'In Filarr, link a deposit box to the access (Pro plan and above).' },
  forbidden: { what: 'The app key is valid but is not allowed here: this database, view, query, SQL, MCP, or this kind of write.', fix: 'Create a key with the endpoints it needs (management UI, **App keys**), or extend this one.' },
  internal: { what: 'An unexpected error inside the gate.', fix: 'Look at the gate\'s log; report it with the log line if it repeats.' },
  ip_forbidden: { what: 'The app key only accepts some addresses, and this request comes from another one.', fix: 'Call from an allowed address, or add yours to the key. Behind a reverse proxy, set `trust_proxy`.' },
  key_expired: { what: 'The app key has expired.', fix: 'Create a new key; the old one stays refused.' },
  key_missing: {
    what: 'Two meanings, told apart by the status.',
    fix: 'See below.',
    byStatus: {
      401: { what: 'No app key on the request.', fix: 'Send `Authorization: Bearer gk_…` (or `X-Gate-Key: gk_…`).' },
      409: {
        what: 'A write is impossible: the gate does not hold the key of the database\'s current generation `(e, g)` (it changed, for instance after another access was revoked). `keys` lists what is missing.',
        fix: 'The access creator opens Filarr (desktop, web or mobile, unlocked): it re-seals the keys within seconds, and writes resume.',
      },
    },
  },
  key_not_found: { what: 'Admin: no app key has this identifier.', fix: 'List the keys (`filarr-gate keys list`) and use one of the identifiers shown.' },
  key_paused: { what: 'The app key is paused.', fix: 'Resume it in the management UI (**App keys**).' },
  key_rate: { what: 'The app key used up its requests for this minute. `Retry-After` gives the seconds to wait.', fix: 'Wait `Retry-After` seconds, or raise the key\'s rate limit.' },
  key_unknown: { what: 'Unknown or revoked app key.', fix: 'Check the key; a revoked key never comes back: create a new one.' },
  login_required: { what: 'Admin: the management API needs a session.', fix: 'Sign in to the management UI, or use `filarr-gate` on the same machine.' },
  method_not_allowed: { what: 'This route does not take this HTTP method (views are read-only; files take `POST` and `GET`).', fix: 'See the API reference for the methods of each route.' },
  name_required: { what: 'A file deposit without a file name, or a saved query without a name.', fix: 'Give the file name (with its extension), or a name to the query.' },
  no_token: { what: 'The gate has no token in service (or, at 409, nothing to export or import without one).', fix: 'Give it the token: `filarr-gate init --token flr_live_…`, the setup screen, or `FILARR_GATE_TOKEN`.' },
  not_found: { what: 'Unknown path, or a feature switched off on this gate (`/metrics`, `/mcp`, `/_filarr/notify`).', fix: 'Check the path; switch the feature on (`metrics`, `mcp`, `notify` settings).' },
  notify_bad_signature: { what: 'A push wake-up whose signature is not valid for this token (not sent by Filarr for this access).', fix: 'Nothing to do if it was not Filarr. After replacing the token, the old wake-ups are refused: this is expected.' },
  notify_malformed: { what: 'A push wake-up without a readable `Filarr-Notify` header or body.', fix: 'Only Filarr calls this route; check what else sends requests to `/_filarr/notify`.' },
  notify_stale: { what: 'A push wake-up signed more than 5 minutes away from this machine\'s clock.', fix: 'Set the machine\'s clock right (NTP); `filarr-gate doctor` shows the gap.' },
  origin_forbidden: { what: 'The request comes from a web page whose origin is not in the CORS list of the gate (CORS is closed by default).', fix: 'Add the page\'s origin to `cors_origins` (for example `https://shop.example.com`). Never put a write key in a public page.' },
  other_access: { what: '`filarr-gate export --for-token` was given the token of ANOTHER access.', fix: 'Give the new token of the same access (the one Filarr shows when you migrate it).' },
  package_unreadable: { what: 'The settings package was sealed for another token: this gate cannot open it.', fix: 'Export again with `--for-token` set to THIS gate\'s token.' },
  password_from_env: { what: 'Admin: the management password comes from `FILARR_GATE_ADMIN_PASSWORD` and cannot be changed in the UI.', fix: 'Change the variable and restart.' },
  query_not_found: { what: 'No saved query has this slug.', fix: 'The management UI (**SQL explorer**) lists the saved queries and their addresses.' },
  row_not_found: { what: 'No live row has this identifier in this database.', fix: 'Check the `id`; a row deleted in Filarr is no longer served.' },
  rows_managed: {
    what: 'The rows of this database come from an external source (mirror, or a natural key): the local API neither creates nor deletes rows here.',
    fix: 'Create or delete the row in the source; the next sync pass brings it to Filarr.',
  },
  same_token: { what: '`export --for-token` was given this gate\'s own token.', fix: 'Give the token of the gate that takes over.' },
  scope_files: { what: 'The app key has no `files` scope: it cannot deposit files.', fix: 'Create a key with the files scope (`filarr-gate keys create --name … --files`).' },
  scope_required: { what: 'Admin: a new app key must open at least one endpoint (or SQL, or MCP).', fix: 'Tick at least one endpoint.' },
  settings_refused: { what: 'Admin: a setting could not be changed: it is fixed by an environment variable or `gate.toml`, or the value is invalid (the message says which).', fix: 'Change it where it is fixed, or correct the value.' },
  setup_code_required: { what: 'Admin: the first setup is done from another machine, which needs the setup code.', fix: 'Type the 6-digit code that the gate printed in its console at start-up.' },
  setup_done: { what: 'Admin: the first setup is already done.', fix: 'Sign in with the management password.' },
  source_not_found: { what: 'Admin: no sync definition naming this gate has this identifier.', fix: 'List them with `filarr-gate sources list`.' },
  sql_empty: { what: 'The SQL query is empty.', fix: 'Send `{ "sql": "SELECT …" }`.' },
  sql_error: { what: 'The query is valid SQL but cannot run (unknown table or column, wrong function…). `sqlCode` gives the engine\'s code.', fix: 'Fix the query; `GET /admin/api/sql/tables` (or the SQL explorer) lists tables and columns.' },
  sql_read_only: { what: 'Only `SELECT` (and `WITH … SELECT`) runs through `/v1/sql`.', fix: 'Write through `POST`, `PATCH` and `DELETE` on the database\'s endpoints.' },
  sql_syntax: { what: 'The query does not parse. `position` points at the character where parsing failed.', fix: 'Fix the syntax (SQLite dialect).' },
  sql_too_long: { what: 'The query is longer than 64 KiB.', fix: 'Shorten it, or save it as a query and call `/v1/q/<slug>`.' },
  tls_missing: { what: 'Admin: the certificate or key file given for HTTPS does not exist on this machine.', fix: 'Give paths that exist and that the gate\'s user can read.' },
  token_from_env: { what: 'Admin: the token comes from `FILARR_GATE_TOKEN` and cannot be replaced in the UI.', fix: 'Change the variable (or the Worker secret) and restart.' },
  token_refused: { what: 'Admin: Filarr refused the token you entered (unknown, revoked or expired), so it was not kept.', fix: 'Copy the whole `flr_live_…` token again; if it was replaced or revoked, get a new one from Filarr.' },
  token_required: { what: 'Library only: `openGate()` without a token.', fix: 'Pass `openGate({ token: process.env.FILARR_GATE_TOKEN })`.' },
  too_many_attempts: { what: 'Admin: 5 wrong passwords in a minute.', fix: 'Wait a minute.' },
  too_many_rows: { what: 'More than 500 rows in one create request.', fix: 'Send 500 rows at most per request.' },
  unknown_field: { what: 'A field name is not in this database (in a filter, `sort`, `fields`, or a written body). `field` names it.', fix: 'Use the JSON field names listed by `GET /openapi.json` (they follow the column names, without accents).' },
  unknown_option: { what: 'A select value is not one of the column\'s options.', fix: 'Send one of the option labels (the message lists them); add the option in Filarr first.' },
  view_not_found: { what: 'This database has no view with this slug.', fix: 'Check the view\'s slug in `GET /openapi.json`. A view renamed in Filarr keeps its slug.' },
  weak_password: { what: 'Admin: the management password must have 10 characters at least.', fix: 'Choose a longer one.' },
  webhook_not_found: { what: 'Admin: no webhook has this identifier.', fix: 'List the webhooks in the management UI.' },
  write_disabled: { what: 'Writing to Filarr is switched off on this gate (the `write` setting, off by default).', fix: 'Set `FILARR_GATE_WRITE=true` (or `write = true` in `gate.toml`, or the Settings screen), and give the key a write right.' },
  write_failed: { what: 'A write failed for an unexpected reason (the message says which).', fix: 'Try again; see the gate\'s log.' },
};

/**
 * Les codes que l'API locale transmet tels quels depuis Filarr (`code` et statut gardés), quand
 * Filarr refuse une écriture ou un dépôt de fichier. Expliqués avec les codes de Filarr plus bas.
 */
export const PASSED_THROUGH = [
  'api_rate',
  'api_quota_writes',
  'api_tier_write',
  'api_write_unavailable',
  'vault_frozen',
  'api_tier_files',
  'files_not_switched',
  'box_not_permanent',
  'box_not_found',
  'box_storage_full',
  'api_quota_files',
  'api_quota_file_bytes',
] as const;

/** Pourquoi une base n'est pas encore servie (`503` avec ce `code`), ou l'est avec un avertissement. */
export const BASE_PROBLEMS: Record<string, CodeText> = {
  base_loading: { what: 'The gate is still making its first copy of this database.', fix: 'Wait a few seconds; `GET /health` says when every database is `ready`.' },
  key_missing: {
    what: 'The gate lacks the key of some blocks `(e, g)`: Filarr changed the database\'s keys and the creator has not re-sealed them for this access yet. The gate never skips a block silently.',
    fix: 'The access creator opens Filarr, unlocked: the keys are re-sealed and the gate catches up on its own.',
  },
  rollback: { what: 'The server answered with an older version than the one already read. The gate refuses to go back.', fix: 'Report it: this should never happen with Filarr\'s servers. Restarting does not hide it.' },
  head_missing: { what: 'Filarr has no head for a version it announced.', fix: 'Wait for the next change; report it if it persists.' },
  head_unverified: { what: 'The database head could not be opened or verified with the keys the gate holds.', fix: 'See `filarr-gate doctor`; if a key was just changed, the creator opening Filarr re-seals it.' },
  slot_missing: { what: 'A block named by the head could not be downloaded.', fix: 'The gate retries on its own; if it persists, run `filarr-gate doctor`.' },
  slot_unreadable: { what: 'A block could not be decrypted.', fix: 'Report it with the log line; the gate keeps serving its last complete state.' },
  slot_substituted: { what: 'A block did not match the fingerprint the head gives for it: someone or something changed it. It is refused.', fix: 'Report it. The gate never serves a block that fails this check.' },
  unreachable: { what: 'Filarr could not be reached while reading this database.', fix: 'The gate retries; reads keep being served from the last complete copy.' },
};

/** L'état de la liaison avec Filarr (`GET /health` → `link`, `status()` de la bibliothèque, `filarr-gate doctor`). */
export const LINK_STATES: Record<string, CodeText> = {
  no_token: { what: 'No token yet.', fix: 'Give the gate its token (setup screen, `filarr-gate init`, or `FILARR_GATE_TOKEN`).' },
  connecting: { what: 'Starting, or reconnecting after a pause.', fix: 'Nothing; it moves on by itself.' },
  live: { what: 'The live stream of changes is open: a change in Filarr reaches the gate in about a second.', fix: 'Nothing.' },
  polling: {
    what: 'No live stream (Free plan, the Cloudflare variant, or the stream refused): the gate polls Filarr at the interval of its plan, and on push wake-ups.',
    fix: 'Nothing. For faster updates without a stream, give Filarr a wake-up address (`/_filarr/notify`).',
  },
  offline: { what: 'Filarr cannot be reached. The gate keeps serving its last copy and retries with a growing delay.', fix: 'Check the machine\'s network and DNS; `filarr-gate doctor` tests Filarr.' },
  limited: { what: 'Filarr limits this access (a `429`): the gate waits for `Retry-After` and keeps serving its copy.', fix: 'See **Usage and limits** (management UI) and the plan\'s limits in Filarr.' },
  paused: { what: 'The access is paused in Filarr.', fix: 'Reopen it in Filarr, **Settings › API access**.' },
  not_switched: { what: 'API access is not open yet for the Filarr account that created the access.', fix: 'Nothing to do on the gate: it starts as soon as Filarr opens it.' },
  ip_forbidden: { what: 'Filarr refuses the IP address of this machine for this access (allowed addresses).', fix: 'Add the machine\'s public address to the access in Filarr, or run the gate from an allowed address.' },
  revoked: { what: 'The access was revoked, or its token replaced: the gate erased its copy and its keys.', fix: 'Give the gate a new token (a replaced token: the new one from Filarr).' },
  expired: { what: 'The access reached its expiry date: the gate erased its copy.', fix: 'Create a new access in Filarr, or extend the expiry before it is reached next time.' },
  unknown_access: { what: 'Filarr does not know this token (mistyped, or from another Filarr server).', fix: 'Copy the whole token again; check `FILARR_GATE_API_URL`.' },
  upgrade_required: { what: 'This version of Filarr Gate is too old for Filarr\'s API.', fix: 'Update Filarr Gate.' },
  pending: { what: 'The token is a new identity waiting for a migration: only the access and the settings package answer.', fix: 'Finish the migration in Filarr ("Erase and change the keys"), or abandon it.' },
  asleep: { what: 'A hosted box is asleep (payment, plan or policy).', fix: 'See **Settings › API access** in Filarr.' },
  error: { what: 'Filarr refused something unexpected; `detail` and the log say what.', fix: 'Run `filarr-gate doctor`.' },
};

/**
 * Les codes que Filarr rend à une boîte (api-base-1, révisions 2 et 3) qui ne sont PAS dans les
 * vecteurs de la révision 3, chacun avec son statut HTTP.
 */
export const FILARR_REV2: Record<string, { status: number } & CodeText & { gate: string }> = {
  api_access_unknown: { status: 401, what: 'Filarr does not know this token.', gate: 'Stops, erases its copy, link `unknown_access`.', fix: 'Copy the whole token again; check `FILARR_GATE_API_URL`.' },
  api_access_revoked: { status: 401, what: 'The access was revoked, or its token replaced.', gate: 'Stops, erases its copy and keys, link `revoked`.', fix: 'Give the gate a new token.' },
  api_access_expired: { status: 401, what: 'The access expired.', gate: 'Stops, erases its copy, link `expired`.', fix: 'Create a new access, or change the expiry in Filarr before it is reached.' },
  api_access_paused: { status: 403, what: 'The access is paused in Filarr.', gate: 'Keeps its copy, serves it, retries; link `paused`.', fix: 'Reopen the access in Filarr.' },
  api_ip_forbidden: { status: 403, what: 'This machine\'s IP address is not allowed for this access.', gate: 'Link `ip_forbidden`, keeps serving its copy.', fix: 'Allow the address in Filarr, or call from an allowed one.' },
  store_not_granted: { status: 403, what: 'The database is not (or no longer) opened to this access, or only for reading when a write was tried.', gate: 'Re-reads its rights; a write becomes `403 base_read_only`.', fix: 'Open the database to the access in Filarr (in read and write to write).' },
  api_base_not_switched: { status: 403, what: 'API access is not open yet for the creator\'s account.', gate: 'Link `not_switched`, retries.', fix: 'Nothing on the gate.' },
  api_tier_stream: { status: 403, what: 'The plan has no live stream (Free).', gate: 'Polls instead, never faster than the plan allows.', fix: 'Nothing; or a plan with live changes.' },
  api_tier_write: { status: 403, what: 'The plan has no API writes.', gate: 'Passes the refusal to the application that wrote.', fix: 'A plan with writes, or read only.' },
  api_write_unavailable: { status: 403, what: 'API writes are not switched on yet on Filarr\'s side.', gate: 'Passes the refusal on.', fix: 'Nothing on the gate.' },
  api_rate: { status: 429, what: 'The access sends too many requests per minute to Filarr.', gate: 'Pauses every exchange with Filarr until `Retry-After`; local reads go on.', fix: 'Nothing; it resumes. Fewer gates on the same token help.' },
  api_poll_interval: { status: 429, what: 'Free plan: a database was polled sooner than allowed.', gate: 'Holds that database until `Retry-After`.', fix: 'Nothing; the gate never polls faster than `poll_seconds` and the plan.' },
  api_quota_sync: { status: 429, what: 'The account used up its sync requests for the month.', gate: 'Holds back that database (head and changes at most every 900 s); local reads go on.', fix: 'Wait for the next month (UTC), or a higher plan.' },
  api_quota_bytes: { status: 429, what: 'The account used up its downloaded volume for the month.', gate: 'Stops downloading blocks until the 1st (UTC); keeps serving what it has.', fix: 'Wait for the next month, or a higher plan.' },
  api_quota_writes: { status: 429, what: 'The account used up its accepted writes (commits) for the day.', gate: 'Refuses the write with `Retry-After` until 00:00 UTC.', fix: 'Batch rows: one request with 500 rows is one commit.' },
  vault_frozen: { status: 409, what: 'The vault of this database is frozen (read only).', gate: 'Refuses the write.', fix: 'See the vault\'s state in Filarr.' },
  client_upgrade_required: { status: 426, what: 'Filarr no longer speaks this version of the protocol.', gate: 'Link `upgrade_required`.', fix: 'Update Filarr Gate.' },
  seq_conflict: { status: 409, what: 'Someone wrote to the database at the same time.', gate: 'Re-reads the head, re-seals and replays (registers merge): invisible to your software.', fix: 'Nothing.' },
  stale_generation: { status: 409, what: 'The database moved to a new generation of keys while the gate was writing.', gate: 'Re-reads and replays under the new key, if it holds it; otherwise `409 key_missing`.', fix: 'Nothing, or let the creator open Filarr.' },
  slot_version: { status: 409, what: 'A block was rewritten meanwhile.', gate: 'Re-reads and replays.', fix: 'Nothing.' },
  bad_cover: { status: 409, what: 'The write\'s list of blocks no longer matches the head.', gate: 'Re-reads and replays.', fix: 'Nothing.' },
};

/** Les explications des codes de la révision 3 des vecteurs (`boite-noire-v2-serveur`), par code. */
export const FILARR_REV3: Record<string, CodeText & { gate?: string }> = {
  reauth_required: { what: 'Entrusting a database to the hosted box needs a fresh proof of identity.', fix: 'Filarr asks for it on screen (password, two-factor code or passkey).' },
  reauth_failed: { what: 'The proof of identity was wrong.', fix: 'Try again; after 10 tries in an hour, wait.' },
  api_tier_hosted: { what: 'The hosted box needs the Pro plan or above.', fix: 'A higher plan, or run the gate yourself.' },
  hosting_forbidden: { what: 'The organization forbids hosted boxes.', fix: 'Ask an organization admin, or run the gate yourself.' },
  hosting_not_switched: { what: 'The hosted box is not open yet for this account.', fix: 'Nothing to do; it opens account by account.' },
  consent_outdated: { what: 'The consent text changed since you accepted it.', fix: 'Filarr shows the new text again; accept it to keep the database entrusted.' },
  host_key_unknown: { what: 'Your Filarr app does not know the hosted service\'s current key.', fix: 'Update the Filarr app.' },
  hosting_billing_unavailable: { what: 'No Stripe subscription can carry the option for this payer.', fix: 'Manage billing in Filarr, or bill the organization.' },
  hosting_exists: { what: 'This access is already hosted.', fix: 'Nothing; use the migration screens to change where it runs.' },
  consent_required: { what: 'Adding a database to a hosted access needs a consent for that database first.', fix: 'Accept the consent for it in Filarr, then add it.' },
  hosting_not_found: { what: 'This access is not hosted.', fix: 'Nothing.' },
  migration_pending: { what: 'A migration of this access is already in progress.', fix: 'Finish or abandon it in Filarr.' },
  migration_not_ready: { what: 'The new gate has not imported its settings package yet.', fix: 'Start the new gate with its new token and wait for the import, then switch.' },
  hosting_too_large: { what: 'The databases to entrust are too large for a hosted box.', fix: 'Entrust fewer databases, or run the gate yourself.' },
  hosting_asleep: { what: 'The hosted box is asleep (payment, plan or policy). `remedy` says what wakes it up.', gate: 'Link `asleep`.', fix: 'See **Settings › API access** in Filarr.' },
  hosted_origin_required: { what: 'A hosted box\'s token was presented outside the hosted service.', gate: 'Refused: a hosted token is useless elsewhere.', fix: 'Nothing; this protects the token.' },
  api_access_pending: { what: 'A new identity waiting for a migration called something other than `self` or its import.', gate: 'Link `pending`; reads its settings package and waits.', fix: 'Finish the migration in Filarr.' },
  api_tier_files: { what: 'Receiving files through the API needs the Pro plan or above.', gate: 'Passes the refusal on (`403`).', fix: 'A higher plan.' },
  files_not_switched: { what: 'Files through the API are not open yet for this account.', gate: 'Passes the refusal on.', fix: 'Nothing; it opens account by account.' },
  files_not_linked: { what: 'No deposit box is linked to the access.', gate: 'Refuses before sending (`409`).', fix: 'Link a deposit box in Filarr.' },
  box_not_permanent: { what: 'The box linked to the access is not a permanent deposit box.', gate: 'Passes the refusal on.', fix: 'Link a permanent box (Filarr creates one for you).' },
  box_not_found: { what: 'The linked deposit box no longer exists.', gate: 'Passes the refusal on.', fix: 'Link another box in Filarr.' },
  deposit_not_found: { what: 'Filarr does not know this deposit.', gate: 'Status unknown.', fix: 'Check the identifier.' },
  box_full: { what: 'Too many deposits wait to be filed in the box.', gate: 'Refuses before sending when it already knows; otherwise passes the refusal on.', fix: 'Open Filarr to file them.' },
  box_storage_full: { what: 'The deposits waiting in the box take too much space.', gate: 'Passes the refusal on (`413`).', fix: 'Open Filarr to file them.' },
  file_too_large: { what: 'The file is larger than Filarr accepts (`limit`).', gate: 'Refuses before sending when it knows the limit.', fix: 'Send a smaller file.' },
  api_quota_files: { what: 'The account deposited as many files as its plan allows this month.', gate: 'Passes the refusal on with `Retry-After` (until the 1st, UTC).', fix: 'Wait for the next month.' },
  api_quota_file_bytes: { what: 'The account deposited as many bytes of files as its plan allows this month.', gate: 'Passes the refusal on with `Retry-After`.', fix: 'Wait for the next month.' },
  ext_status_conflict: { what: 'Two writers published a sync\'s state at the same time.', gate: 'Re-reads the revision and publishes again.', fix: 'Nothing.' },
  ext_queue_conflict: { what: 'Two writers published a sync\'s conflict queue at the same time.', gate: 'Re-reads the revision and publishes again.', fix: 'Nothing.' },
  ext_resolve_full: { what: 'Too many decisions wait for the sync\'s runner.', fix: 'Make sure the gate that runs the sync is running; it reads the decisions at its next pass.' },
  extdb_lease_held: { what: 'Another process holds this sync\'s lease (two gates started with the same token).', gate: 'Skips the pass, state `waiting` (`extdb_lease_held`), retries later.', fix: 'Run one gate per token; stop the other instance.' },
  extdb_relay_off: { what: 'Web only: Filarr\'s relay for external databases is switched off.', fix: 'Run the sync from the desktop app or a gate.' },
};

/** Les états d'une synchro externe, tels que la boîte les publie (`code` de l'état scellé, jamais un statut HTTP). */
export const SYNC_CODES: Record<string, CodeText> = {
  extdb_key_missing: { what: 'The key of the external database is not given to the gate.', fix: 'Give it: **Sources** screen, `filarr-gate sources key <id> --stdin`, `FILARR_GATE_EXTDB_<ID>`, or `gate.toml`.' },
  extdb_key_refused: { what: 'The external database refused the key (401 or 403). Nothing was deleted.', fix: 'Create a new key with the rights the sync needs, and give it to the gate.' },
  extdb_unreachable: { what: 'The external database did not answer (or a TCP connector on a variant without TCP).', fix: 'Check the host and the network from the gate\'s machine; PostgreSQL and MySQL need the Node or Docker gate.' },
  extdb_timeout: { what: 'The external database took too long.', fix: 'Check its load; add an index on the key and on the change marker.' },
  extdb_tls: { what: 'The secure connection failed (certificate).', fix: 'Fix the certificate, or choose `require` in Filarr; `off-local` only on a local network.' },
  extdb_not_found: { what: 'The table, sheet or database does not exist (or a `query` source was asked to write).', fix: 'Check the names in the sync definition.' },
  extdb_upstream_limited: { what: 'The external service asks to slow down (429).', fix: 'Nothing; the gate waits and the next pass resumes.' },
  extdb_too_large: { what: 'More than 100,000 rows read for one definition.', fix: 'Narrow the source (a query, a view, a filter).' },
  extdb_schema_changed: { what: 'The source\'s columns changed: a choice waits in Filarr.', fix: 'Open the database in Filarr and choose.' },
  extdb_quota_writes: { what: 'Filarr\'s writes of the day are used up; the changes wait until 00:00 UTC. Nothing is lost.', fix: 'Nothing; or fewer passes.' },
  extdb_tier: { what: 'The plan has no scheduled sync (Solo and above).', fix: 'A higher plan.' },
  extdb_unsigned: { what: 'The definition is not signed by the access creator (changed by someone else), or the creator\'s key is not authenticated.', fix: 'The creator approves the change in Filarr; an access without a creator tag needs its token replaced.' },
  extdb_lease_held: { what: 'Another instance of this gate runs this sync.', fix: 'Run one gate per token.' },
  extdb_guard: { what: 'Safety stop: too many rows would be marked or deleted at once. Nothing was written.', fix: 'Check the source; to go on for this pass only, agree in Filarr or run `filarr-gate sources run <id> --ack-guard <pass>`.' },
  extdb_conflict_burst: { what: 'Too many new conflicts in one pass. Nothing was written.', fix: 'Check the direction and the row key; on a first pass, settle it with `--initial source` or `--initial filarr`.' },
  extdb_def_newer: { what: 'The definition was written by a newer version of Filarr.', fix: 'Update Filarr Gate.' },
  extdb_conflicts_pending: { what: 'The sync runs; some cells wait for a decision in the "ask me" queue.', fix: 'Settle them in Filarr; the next pass applies the decisions.' },
  extdb_queue_full: { what: 'The "ask me" queue is full; new conflicts wait for room and their cells do not sync.', fix: 'Settle conflicts in Filarr, or choose an automatic policy.' },
  extdb_policy_missing: { what: 'A two-way definition without a conflict policy (written by an older Filarr). Nothing runs.', fix: 'Choose the policies in Filarr; it signs the definition again.' },
  extdb_def_invalid: { what: 'Gate only: the definition fails validation (the detail lists the codes, such as `host_mismatch`).', fix: 'Fix the definition in Filarr.' },
  extdb_not_runner: { what: 'Gate only: a one-off import (`once`) is never run by a gate; it runs in the Filarr app.', fix: 'Run the import from Filarr.' },
  extdb_relay_limited: { what: 'Web only: the relay\'s rate for external databases is used up.', fix: 'Wait, or run the sync from the desktop app or a gate.' },
  extdb_web_unsupported: { what: 'Web only: this connector cannot be reached from a browser (PostgreSQL, MySQL).', fix: 'Run the sync from the desktop app or a gate.' },
};
