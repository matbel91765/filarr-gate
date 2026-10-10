# Move to the hosted box, then come back home

> **Coming soon.** The box hosted by Filarr is not open yet: it opens after an external security review, account by
> account, and this page describes it as the frozen contract `gate-heberge-1` fixes it. What already works today is the
> gate's half of the move: the settings package (`gate-settings-1`) that carries your app keys, webhooks and saved
> queries from one gate to the next, online or as a file, run by the test suite.

**At the end** you will know what "hosted by Filarr" changes, how to entrust databases to it, how to take the key
back to a gate of your own with the same app keys and webhooks, and what the erasure receipt proves and does not prove.

**Plan:** a paid option from Pro (one box included per Teams or Enterprise organization). The price is on Filarr's
pricing page and in **Settings › API access**.

## What changes, said plainly

With a gate of your own, Filarr never reads your databases. With the hosted box, **for the databases you entrust to
it and while they stay entrusted**, a service of Filarr holds their key and runs the same Filarr Gate for you:

- it can technically read **every row and every column** of those databases, including what no view shows, and what
  is written to them meanwhile;
- the calls of your software and the answers pass through `https://<name>.gate.filarr.com`, a name of filarr.com:
  the Cloudflare account that manages filarr.com, the one that also serves Filarr's API, can technically see them **in
  transit**;
- if you connect an external database to it, Filarr holds its key and sees its rows; if the box receives files, Filarr
  sees them in passing.

Your other databases, your notes, your files and your vaults stay unreadable to Filarr. Filarr commits to not logging
this content, to using it only to serve your API, to keeping its copies in the European Union, and to erasing the key
and the copy when you take it back: **these are commitments, not protection by encryption**. Taking the key back
changes the keys of those databases: the box can no longer read what is written afterwards; what it read before stays
covered by the commitments only. The full model: [security and trust](../security-and-trust.md#hosted-by-filarr).

## Entrust databases (in Filarr)

When you open a database to an API, "Where does the gate run?" offers **on my side** (the default) or **at
Filarr**. At Filarr:

1. tick each database to entrust (none is ticked for you);
2. read the consent and tick "I understand that Filarr will be able to read the checked databases while they are
   entrusted to it" (the text is versioned: a change of text asks you again);
3. prove it is you again (password and two-factor code, or a passkey);
4. **Entrust 1 database to Filarr**.

Your device draws the token and seals it to the hosted service's key, which the apps carry built in: nobody sees the
token, not even you. It shows you the box's address (`https://site-vitrine-7qm2.gate.filarr.com`) and a first app key
(`gk_…`), once. There is no management UI on the hosted box: its app keys, webhooks, saved queries and file filter are
set in **Settings › API access**.

Everyone who can see an entrusted database sees it marked "API hosted by Filarr · Filarr can read this database", on
every device; the members of a vault are told who entrusted it. Only the vault's owner or admins can entrust or take
back a database of a vault.

Asleep: if the payment fails or the plan goes below Pro, the box sleeps for 30 days (it answers `503 gate_asleep`; the
key is kept), wakes up when it is paid, and is erased with a receipt at the end of the 30 days.

## Come back home

Five steps, without stopping your software:

1. **Install a gate** where you want it ([computer](install-local.md), [Docker](install-docker.md),
   [Cloudflare](install-cloudflare.md)). Do not give it a token yet.
2. **Prepare**, in Filarr (**Settings › API access**, the hosted access, **Bring it back home**): your device draws a
   new identity for the access and shows its token once. It waits as a "pending identity" for 7 days; the hosted box
   keeps serving meanwhile. The hosted box checks that the new identity is signed by you, seals its settings for it,
   and drops them at Filarr.
3. **Start your gate with the new token**:

   ```sh
   filarr-gate init --token flr_live_<the new token>
   filarr-gate
   ```

   It starts in the link state `pending`: it can read only the access and its settings package, which it opens and
   applies (the same app keys, webhooks and saved queries). The **Log** screen shows `réglages importés` with the
   number of keys, webhooks and queries.
4. **Change the address** in your software, from `https://<name>.gate.filarr.com` to your gate's. Your app keys are the
   same: only the address changes. (Filarr can redirect the old address to the new one for 30 days, but most HTTP
   clients drop the `Authorization` header when they follow a redirect to another host: change the address anyway.)
5. **Switch**, in Filarr: "Erase and change the keys". The new identity becomes the access's, the old token is refused,
   the hosted service erases the key, the copy and the box's state, and signs a receipt; your device moves each
   database to a new generation of keys.

The keys of external databases are **not** in the package: on your own gate a key never transits through Filarr.
Filarr held them: change them at their provider, then give the new ones to your gate (`filarr-gate sources key`).

### The same move, as a file

Without the online path (offline, or between two gates of your own), the old gate seals its settings for the new
token, and the new gate applies them:

```sh
filarr-gate export --for-token flr_live_<the new token> --out gate-settings.json     # on the old gate
filarr-gate init --token flr_live_<the new token> --import gate-settings.json         # on the new one
```

The package holds the fingerprints of the app keys (a program keeps its `gk_…` key), the webhooks and their secrets
(the receivers keep verifying), the saved queries, the encrypted state of the syncs, the file filter, CORS and the
`write` setting. Never the management password, never an external database key. It is sealed for the new token only;
another gate cannot open it. More: [explain/migration.md](../explain/migration.md).

## The erasure receipt

```json
{ "v": 1, "kind": "filarr-gate-host/erasure", "keyId": "h1", "accessId": "…", "hostName": "site-vitrine-7qm2",
  "reason": "migrated", "stores": [{ "storeId": "…", "g": 4 }], "erased": ["token", "dbKeys", "copy", "state", "extdbKeys"],
  "requestedAt": "…", "erasedAt": "…", "version": "0.2.0", "codeHash": "sha256:…" }
```

signed by the hosted service's key, kept 5 years in the access's log, shown by the apps with the generation after the
move ("generation 4 → 5"). **It proves the service executed the order; it cannot prove that no copy exists
elsewhere.** What is written from then on in those databases is unreadable to the old box: that is guaranteed by
encryption.

## Next

- [Security and trust](../security-and-trust.md): who sees what in each mode, and how to check the hosted service's
  code.
- [Revoke an access](revoke.md), hosted or not.
- In Filarr's help: [the hosted gate](https://filarr.com/en/docs/gate-hosted), [what Filarr can see](https://filarr.com/en/docs/gate-hosted-trust)
  and [a vault database entrusted to Filarr](https://filarr.com/en/docs/gate-sharing-vaults).
