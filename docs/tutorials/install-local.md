# Install the gate on your computer

[Lire en français](install-local.fr.md)

**At the end** you will have Filarr Gate running on your computer, its management UI open, an app key, and a first
answer from the local API with `curl`. It takes about ten minutes.

**Plan:** opening a database to an API is offered on every Filarr plan (Free: one access, changes polled every few
minutes, no writes). The limits of each plan are on Filarr's pricing page and in **Settings › API access**.

## Before you start

- **Node.js 20.19 or newer** (`node --version`).
- **A token** `flr_live_…`: Filarr shows it once when you open a database to an API
  ([open a database to an API](open-a-database.md)). No Filarr account at hand? Step 2 gives you an in-memory Filarr
  with three demo databases, enough to follow every tutorial.
- The gate is the npm package `filarr-gate`; the commands below call it `filarr-gate`.

## 1. Get the gate

```sh
npm install -g filarr-gate@0.2
filarr-gate version
```

(Or, without installing it: `npx filarr-gate@0.2 <command>`.)

**Or from a clone** of this repository, which also gives the in-memory Filarr of step 2:

```sh
git clone https://github.com/filarr-work/filarr-gate.git
cd filarr-gate
npm ci
npm run build
```

`npm run build` builds the library, the command and the management UI. Then make an alias for this shell:

```sh
alias filarr-gate="node $PWD/packages/cli/dist/cli.js"
filarr-gate version
```

In PowerShell:

```powershell
$gateCli = "$PWD\packages\cli\dist\cli.js"; function filarr-gate { node $gateCli @args }
```

## 2. (Optional) A Filarr to try with

In a second terminal, from a clone (step 1):

```sh
npm run mock-filarr
```

It starts an in-memory Filarr on `http://127.0.0.1:8790` with three databases (Clients, Commandes, Catalogue) opened
to an access called "ERP Atelier", prints that access's token, and makes a change every 20 seconds so you can watch
changes arrive. Then, in your first terminal, point the gate at it:

```sh
export FILARR_GATE_API_URL=http://127.0.0.1:8790     # PowerShell: $env:FILARR_GATE_API_URL = "http://127.0.0.1:8790"
```

Skip this step with a real token: the gate talks to `https://api.filarr.com` by default.

## 3. Give the gate its token

Two ways; choose one.

**With the command** (the token and the management password are stored in the state directory, `~/.filarr-gate`,
in files only your user can read):

```sh
filarr-gate init --token flr_live_… --admin-password 'a-long-password-here'
```

**With the setup screen**: skip `init`, start the gate (next step) and open its UI. Three steps: **1 · The access
token** (paste it, then **Check the token**: the gate asks Filarr, derives its keys and downloads the encrypted
blocks), **2 · Where your software finds it** (the port, HTTPS if you have a certificate), **3 · Protect this
interface** (the management password, ten characters at least).

> The token never leaves this machine. The gate derives from it the proof it shows Filarr and the key that opens the
> databases; Filarr only keeps a fingerprint. Whoever holds the token, or the management password, reads the
> databases it opens: treat both like the keys to the data.

## 4. Start it

```sh
filarr-gate
```

```text
2026-10-10T03:23:19.567Z INFO  API locale : http://127.0.0.1:8443
2026-10-10T03:23:19.570Z INFO  Interface de gestion : http://127.0.0.1:8787/admin/
2026-10-10T03:23:19.609Z INFO  liaison avec Filarr : connecting
2026-10-10T03:23:19.711Z INFO  liaison avec Filarr : live (Flux des changements ouvert)
```

(The command line speaks French for now; [the command reference](../reference/cli.md) gives every command in
English.) The local API listens on `127.0.0.1:8443`, the management UI on `127.0.0.1:8787`: both answer this machine
only. `live` means a change made in Filarr reaches the gate within a second; `polling` (Free plan) means it checks
at the interval of the plan.

Open <http://127.0.0.1:8787/admin/>. The **Dashboard** shows the databases, their rows, the link with Filarr;
**Databases and endpoints** shows each database's address (`/v1/clients`), its views (`/v1/clients/clients-actifs`) and
its fields.

## 5. Create an app key

Your software never gets the Filarr token: each program gets its own **app key** (`gk_…`), limited to what it
needs. Keep the gate running and, in another terminal:

```sh
filarr-gate keys create --name "First try" --sql
```

```text
Clé « First try » :

  gk_fir_6Hq…

Elle ne sera plus montrée.
```

The key is printed once; the gate only keeps its fingerprint. This one reads every view and runs SQL. For a narrower
key (one database, one view, writes, an expiry, allowed addresses), use **App keys › New key** in the UI.

## 6. Your first call

```sh
export FILARR_GATE_KEY=gk_fir_6Hq…
curl -s -H "Authorization: Bearer $FILARR_GATE_KEY" "http://127.0.0.1:8443/v1/clients?limit=2"
```

```json
{"rows":[{"id":"r_acme","nom":"Acme","ville":"Lyon","statut":"Client","ca":12600,"dernier_contact":"2026-10-03",
"commandes":["r_c1","r_c3"],"total_commande":1540.5,"created_at":"2026-09-01T08:00:00.000Z",
"updated_at":"2026-10-10T03:23:24.649Z"},{"id":"r_globex","nom":"Globex", …}],"next":"o2","total":4,"version":2}
```

Each row is a JSON object: one field per column, named after it (`Dernier contact` becomes `dernier_contact`), plus
`id`, `created_at` and `updated_at`. Continue with [first calls](first-calls.md): filters, views, SQL, writes.

## Check that it works

```sh
curl -s http://127.0.0.1:8443/health
filarr-gate doctor
```

```text
ok    filarr                 http://127.0.0.1:8790 répond 200 en 4 ms
ok    horloge                écart avec Filarr : -1 s
ok    jeton                  liaison : live (Flux des changements ouvert) · flr_live_cMAs…SZQg
ok    créateur               clé du créateur : authenticated
ok    base clients           ready · 4 lignes
ok    base commandes         ready · 3 lignes
ok    base catalogue         ready · 2 lignes
…
```

`/health` answers `{"status":"ok","link":"live",…}` with each database and its version; `doctor` prints one line per
check (Filarr reachable, the clock, the token, the creator's key, each database, the month's usage) and exits with 1
when one fails.

## Keep it running

`filarr-gate` stops with its terminal. To keep it running, start it as a service: a systemd unit on Linux
(`ExecStart=/usr/bin/node /opt/filarr-gate/packages/cli/dist/cli.js`,
`Environment=FILARR_GATE_STATE_DIR=/var/lib/filarr-gate`, `Restart=always`, a dedicated user), a launchd agent on macOS,
a scheduled task "at startup" on Windows; or use [Docker](install-docker.md), which restarts it for you.

What the state directory holds, and what it never holds: the token (unless given by `FILARR_GATE_TOKEN`), the
fingerprints of the app keys, the webhook secrets, the encrypted blocks exactly as Filarr stores them, the local log;
never a decrypted row. Details in [security and trust](../security-and-trust.md).

## Next

- [Call the API](first-calls.md) with curl, JavaScript or Python.
- [Receive changes by webhook](webhooks.md).
- [Install it on a server with Docker](install-docker.md), or [on your Cloudflare account](install-cloudflare.md).
- Every setting: [configuration](../reference/configuration.md).

## If it does not work

- `EADDRINUSE`: another program uses 8443 or 8787: `FILARR_GATE_PORT=9443 filarr-gate`.
- `revoked`, `expired`, `unknown_access` in the log: the token is no longer valid; get a new one from Filarr.
- A database is missing or answers `503`: see
  [troubleshooting](../troubleshooting.md#a-database-is-missing-or-answers-503).
