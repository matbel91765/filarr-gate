# Open a database to an API

[Lire en français](open-a-database.fr.md)

**At the end** you will have, in Filarr, an **access** that opens one or more databases to your software, its
**token** saved, and the gate showing those databases at stable addresses such as `/v1/clients` and
`/v1/clients/clients-actifs`.

This part happens in the Filarr app (desktop or web). The user help of Filarr describes the same screens from the
app's side: <https://filarr.com/en/docs/api-access>.

**Plan:** every plan can open a database to an API. The plan sets how many accesses you can have, how many databases
one access opens, whether writes and live changes are included (Solo and above) and whether you can restrict the
addresses that may sync (Pro and above). Filarr shows your limits on the form itself, and in **Settings › API access**.

## What an access is

An access is a key that opens **only the databases you choose**, never your account, your notes or your files. You
create it in Filarr; Filarr shows its token once and keeps only a fingerprint of it. The gate, which you run, holds the
token: it downloads the encrypted blocks of those databases, decrypts them with keys derived from the token, and serves
your software. Filarr keeps seeing encrypted blocks only.

Each database keeps its own key: removing one database from an access changes that database's key without touching
the others.

## Before you start

- A Filarr account signed in on this profile, the app unlocked.
- A database in a note. You must own it; for a database of a vault, you must be the vault's owner or an admin.
- Not every database can be opened: a database backed by a folder (its rows are files) or kept in your own storage
  (BYOS) cannot. Opening a small database moves it to Filarr's database store first, whatever its size; this changes
  nothing for you.

## 1. Open the form

On the database, click **···** then **Open to an API…**.

The item is greyed out, with the reason, when the note is read only, when no account is signed in, when large
databases are switched off on this device, or when you are not the vault's owner or an admin.

## 2. Fill it in

- **Access name**: who will use it ("ERP Atelier", "Website"). It names the gate in Filarr and in its logs.
- **Databases opened**: the database you started from is ticked; tick others to open them with the same token. For each
  one, choose **Read** or **Read and write**. (Writing also needs a plan with API writes; otherwise the choice reads
  "Read and write (not in your plan)".)
- **Slugs**: the names of each database and each view in the gate's API, proposed from their titles (lower case,
  no accents, dashes): `clients`, `clients-actifs`. **They can only be chosen now.** Afterwards they never change,
  even when you rename the database or a view in Filarr, so your integrations do not break. A view created later
  gets its slug when it is published.
- **Linked databases left closed**: if a database has a relation to a database you did not tick, the form names it.
  The gate never reads a database it was not given: those relations will give raw row ids, and their rollups will be
  empty. **Open it too** adds it.
- **Expires**: in 6 months, in 1 year, or never. At the expiry Filarr refuses the token and the gate erases its copy.
- **Addresses allowed to sync** (Pro and above): Filarr refuses the token from any other IP address. Write addresses
  or ranges separated by commas (`203.0.113.7, 10.0.4.0/24`): the public address of the machine that runs the gate.

The top of the form shows your plan and how many accesses are open. **Create the access**.

## 3. Save the token

Filarr shows the token **once**:

```text
flr_live_7Qm2kT…  (75 characters)
```

Copy it into the place the gate will read it from: your password manager, a secret of your server or of your
Cloudflare account. Filarr keeps only a fingerprint: a lost token cannot be shown again, only replaced. Whoever holds
it reads the databases it opens: treat it like a password.

The screen offers four ways to run the gate (on this computer, Docker, in your code, Cloudflare). Follow the
matching tutorial: [your computer](install-local.md), [a server with Docker](install-docker.md),
[your Cloudflare account](install-cloudflare.md), or [the library in your code](library.md). Then click
**I saved the token**.

If some old blocks of the database use a key this device no longer holds, the screen warns that the gate will report
them as "missing key" until a device that holds it opens Filarr.

## 4. Give it to the gate

```sh
filarr-gate init --token flr_live_…
filarr-gate
```

or `FILARR_GATE_TOKEN=flr_live_…`, or the setup screen of the management UI. As soon as the gate first syncs, it
appears in Filarr under **Settings › API access**, with its version, its address and when it was last seen.

## Check that it works

In the gate's UI, **Databases and endpoints** lists each database with its address, its views, its fields and the keys
allowed to read it. Or:

```sh
curl -s http://127.0.0.1:8443/openapi.json | head -c 400
```

`/openapi.json` is the exact description of what this gate serves: each database, each field with its type, each
view, ready for Postman, n8n, Make or a client generator.

## What Filarr sees, what the gate sees

- **Filarr** sees the access, the fingerprint of its proof, sealed keys and views it cannot open, counters, and the
  gate's IP address and version. Never the token, a key or a row.
- **The gate** sees every row and every column of the databases you opened, not only what the views show. **A view is
  a convenience, not a boundary**: to share less, open a database that holds less.
- More: [security and trust](../security-and-trust.md).

## Next

- [Create keys for your software and call the API](first-calls.md).
- Manage the access (pause, replace the token, remove a database, revoke): [revoke and react to a leak](revoke.md).

## If it does not work

- "Not available yet": API access is not open yet for your account.
- "Only the owner or an admin of the vault can open its databases": ask the vault's owner.
- The gate says `key_missing` for a database: some blocks use a key this device did not hold; open Filarr on a device
  that holds it, unlocked, and the keys are re-sealed.
- More: [troubleshooting](../troubleshooting.md).
