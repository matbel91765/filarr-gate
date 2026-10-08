# Security

Filarr Gate holds decryption keys. We take reports seriously.

- Report privately through GitHub's **"Report a vulnerability"** (Security tab of this repository). Do not open a
  public issue.
- Include what you found, how to reproduce it, and the impact you expect.
- We acknowledge within 3 working days and keep you informed until a fix ships.

## Scope

In scope: the gate's handling of the access token and derived keys, the verification of sealed grants, heads and
blocks, the local API's authentication (app keys, rate limits, IP allow-lists, CORS), the management interface
(sessions, CSRF guard, setup code), webhooks (signatures), and anything that would write decrypted data to disk or send
it anywhere but the configured webhook URLs.

Out of scope: a compromised host (whoever controls the machine running the gate, or knows its management password,
reads the opened databases by design), denial of service by an authenticated app key within its own rate limit, and
the Filarr servers themselves (report those to Filarr).

## What the gate keeps

- In memory: the derived keys (`A_auth`, `A_enc`), the opened database keys `K_db(e, g)`, the decrypted rows.
- On disk (state directory, files 0600 where the platform allows): the token (unless it comes from
  `FILARR_GATE_TOKEN`), app key hashes (SHA-256), webhook signing secrets, the admin password hash (scrypt), settings,
  encrypted blocks exactly as Filarr stores them (unless `FILARR_GATE_CACHE=memory`), and the local log (paths, codes,
  durations; no row content, no token).
- Never on disk: a database key, a decrypted row, a webhook payload (pending retries live in memory).
- Never on the network: the token or its `secret`. Filarr only receives the `A_auth` proof; webhook targets only
  receive the rows their webhook selects.
