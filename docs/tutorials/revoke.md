# Revoke an access, and react to a leak

[Lire en français](revoke.fr.md)

**At the end** you will know which of the five gestures to use (revoke an app key, pause, replace the token, remove a
database, revoke the access), what each one protects, what a gate that was offline keeps, and how to check in the logs
that it worked.

**Plan:** every plan.

## Two kinds of keys, two places

| | where it lives | who revokes it | what it protects |
|---|---|---|---|
| an **app key** `gk_…` | the gate (one per program) | the gate's administrator, at once | the gate's API: what one program can call |
| the **token** `flr_live_…` | the gate only (Filarr keeps a fingerprint) | you, in Filarr | the databases themselves |

## A program's app key leaked

Revoke it on the gate; it stops working at the next request. The token, the other keys and Filarr are untouched.

```sh
filarr-gate keys list
filarr-gate keys revoke gk_erp_3k        # its id, or the start of its prefix
filarr-gate keys create --name ERP       # a new one, printed once
```

(or **App keys › Revoke** in the management UI). A key with an expiry (`--days 90`, or "Expires" in the UI) and
allowed addresses limits the damage a leak can do in the first place.

## Gestures on the token, in Filarr

All in **Settings › API access**, on the access:

| gesture | what happens at once | what it protects |
|---|---|---|
| **Pause** | Filarr refuses the token; the gate keeps its copy, keeps serving it, and resumes when you **Reopen** | a pause while you check something |
| **Replace the token** | a new token, shown once; the old one is refused at once; the gate erases its copy and its keys (`revoked`, "token replaced in Filarr: paste the new token") | a token you no longer trust, for an access you keep |
| **Remove** a database | that database leaves the access; **its keys change** (next generation); the other databases are untouched | one database no longer shared |
| **Revoke** | the token is refused at once; the gate erases its copy; **the keys of every database of the access change** | a token that leaked, a machine you no longer trust |

Why "the keys change" matters: a database's key is derived for a **generation**. The token held the keys of the
current generation. After a revocation (or a removal), Filarr's app moves the database to the next generation and
re-seals the new keys for the other accesses only: whatever is written afterwards is unreadable with the old token, even
if someone got hold of the encrypted blocks some other way. **Replacing the token does not change the keys**: the
server refuses the old token, but the keys it held stay valid for what is already written and what comes. If the token
leaked, revoke and create a new access.

When the keys change, the device that made the gesture does the work: it needs the vault open and the server
reachable. Otherwise Filarr says "The keys of these databases will change as soon as their vault is open and the
server reachable", and a device of yours does it at its next opening.

## What a gate keeps

- **A gate that is online** stops within a second (the live stream tells it), erases the keys and the decrypted rows
  from memory, and deletes its cache of encrypted blocks.
- **A gate that was offline** learns it at its next contact with Filarr and does the same. Until then, it can only serve
  the copy it already had: **what it already copied stays on its machine** until it reconnects or someone erases it.
  If the machine is no longer trusted, erase it there: the management UI's **Settings › Forget this machine** (copy,
  derived keys, token, app keys, webhooks, log), or delete the state directory.
- **Your app keys and webhooks survive a token replacement** on a gate you keep: give it the new token (**Settings ›
  Replace the token** in its UI, or `FILARR_GATE_TOKEN` and a restart) and they work again. The keys of external
  databases are encrypted under a key derived from the token: give them again.

## Replace a token without a long cut

1. In Filarr, **Replace the token**; copy the new one.
2. At once, on the gate: **Settings › Replace the token** in its UI (or update `FILARR_GATE_TOKEN` and restart; on
   Cloudflare, `npx wrangler secret put FILARR_GATE_TOKEN`).
3. The gate downloads the copy again (its encrypted cache was deleted); your software gets `503` for these seconds.

## Check that it worked

- In Filarr, the access's log ("What Filarr saw") shows `revoked` or `token replaced`, then `keys changed · <database>
  (generation g)` for each database, and every later presentation of the old token as `token refused`.
- On the gate, `filarr-gate doctor` shows the link `revoked`; `/health` answers `"link":"revoked"`; the **Log** screen
  shows when it erased.

```sh
curl -s http://127.0.0.1:8443/health
```

```json
{"status":"degraded","link":"revoked","version":"…","bases":[]}
```

## The machine itself was compromised

Revoke the access in Filarr (the keys change), then create a new access for a clean machine. Change, at their source,
everything the old gate held: the keys of external databases (D1 token, PostgreSQL password…), the webhook secrets
(your receivers must stop trusting the old ones), and the app keys (create new ones; the fingerprints of the old ones
were on that machine).

## Next

- [Security and trust](../security-and-trust.md): what each party sees, and what revocation guarantees exactly.
