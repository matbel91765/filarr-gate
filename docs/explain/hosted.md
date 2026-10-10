# The hosted service, and how to check it yourself

[Lire en français](hosted.fr.md)

> Coming soon: the box hosted by Filarr is not open. Its code is in this repository (`packages/host`); it goes into
> service only through the release chain, and the offer opens after an external security review. What is no longer
> end-to-end encrypted in that mode, and what protects it: [security and trust](../security-and-trust.md#hosted-by-filarr).
> The move there and back: [tutorial](../tutorials/hosted-and-back.md).

## How it is mounted

| | |
|---|---|
| where it runs | one Worker script, `filarr-gate-host`, in the same Cloudflare account as Filarr's API, **isolated by script**: its own Durable Objects, its own secrets, and no binding to any resource of the API (database, buckets, key-value store, its objects, service bindings), nor from the API to it |
| one box | one Durable Object per hosted access (`GateBox`), **created in the EU jurisdiction**: storage and execution of the object stay in the EU |
| addresses | the route `*.gate.filarr.com/*` of the `filarr.com` zone (a proxied wildcard DNS record `*.gate`, and an advanced certificate for `*.gate.filarr.com`, which the zone's universal certificate does not cover) |
| `<name>.gate.filarr.com` | a box: its API (`/v1/…`, `/openapi.json`, `/mcp`, `/health`) and its signed management channel; an unknown name answers `404` |
| `ctl.gate.filarr.com` | the control address, the same for every box: it receives Filarr's wake-ups and serves the version announcement |
| keys | `HOST_ENC` (X25519, opens the sealed tokens) and `HOST_SIG` (Ed25519, signs the requests to the API, the erasure receipts and the version announcement), secrets of this script only; their public halves are in [`hosted-keys.json`](../hosted-keys.json), built into the service and into Filarr's apps |
| logs | none: the `observability` block is present and switches everything off (`enabled`, logs, invocation logs, traces), with `logpush: false`, because an absent block would leave the account's default; no tail consumer (`packages/host/wrangler.jsonc`, checked by a test that refuses a trace switched on and an absent block); the only console line is an error code from a closed list |

**What this isolation guarantees.** A flaw or a compromise of the API's code reaches neither the service's secrets, nor
the boxes' objects, nor a token in clear: that code has no binding to them, and the token is stored at the API only
sealed to the service's key.

**What it does not guarantee, said as it is.** It does not protect from an administrator of the Cloudflare account,
who can deploy code that reads the service's secrets or its objects: what frames that is deployment by the release
chain only, the public log, the external review and Filarr's commitment, not a technical barrier. The requests and
answers of a hosted box are not end-to-end encrypted in transit: the account that manages `filarr.com` terminates TLS
for these names. Nothing protects from Cloudflare, the host.

## What a box does

| moment | what happens |
|---|---|
| wake-up | Filarr's API posts a wake-up to `ctl.gate.filarr.com/_filarr/notify/<access>`, signed with a key of that access (no content: it says "read again"). The box checks it, then reads its state from the API through a request signed by `HOST_SIG` |
| opening | the box reads its sealed token, opens it with `HOST_ENC` in memory, derives its keys, and starts the same Filarr Gate core as at home, through the Cloudflare adapter (`packages/cloudflare`). The first app key arrives inside the sealed token, as a fingerprint only |
| at rest | everything the box stores is encrypted with a key derived from the token (`K_box`, AES-256-GCM, each entry bound to the access and to its place). `K_box` exists in memory only: once the API erases the sealed token, what is stored can no longer be decrypted. Kept in clear: the access identifier, the box's name, its state, the reason and end of a sleep, the databases held and their generation, the month's call count, a receipt to hand over. Nothing from a database, a program or a setting |
| requests to the API | every one carries, besides the access's proof, the service's signature (`Filarr-Gate-Host`); without it, Filarr's API refuses a hosted token |
| management | no web interface. Filarr's apps manage the box through `/_admin/…`, each request signed by the creator's identity key (the key that the access's creator tag authenticates, pinned in the box's encrypted state) over the method, the path **with its query**, the time (300 s of clock skew at most) and the body's hash; each signed request is accepted once (a replay gets `401 admin_replay`). Changing the token, a password, forgetting the box or importing a file are closed on the service; the web app and the desktop app are the only origins admitted |
| calls | the month's calls are counted per box, up to the plan's ceiling (`hostedCallsPerMonth` of `GET /public/api-limits`); beyond, `429 hosted_quota_calls` until the 1st of the next month (UTC). The total is handed to Filarr's API every hour |
| sleep | unpaid, lower plan, organisation policy, emergency stop: the box serves nothing (`503 gate_asleep`, with the reason), empties its memory, and keeps its encrypted state and its sealed token. It wakes up on its own when the API says so. Taking it back home stays possible while it sleeps |
| taking back home | the box seals its settings package (app key fingerprints, webhooks, saved queries, never a password nor an external database key) to the new identity, after checking that the creator signed it with the pinned key |
| erasure | revocation, end of sleep, completed move: the whole storage of the object is erased, its memory emptied, then a **receipt signed** by `HOST_SIG` is handed to Filarr's API (reason and time of the request, as the API gives them, databases and generation held, what was erased, version, `codeHash`). A database withdrawn alone gives a partial receipt (`withdrawn`, with its cause — creator, vault admin, outdated consent — read from the API; `withdrawn` never names a full erasure). After a move with a redirect, the old address answers `308` for 30 days, without reading or keeping the request |

The receipt proves that the service carried out the order. It cannot prove that no copy exists elsewhere; what is
written afterwards to the database is unreadable to the old box, and that is guaranteed by encryption.

The box's own log (its "Journal" screen at home) stays in its state, encrypted with `K_box`, readable only through the
signed management channel.

## What a hosted box announces

`https://<name>.gate.filarr.com/.well-known/filarr-gate-host.json` (and the same on `ctl.gate.filarr.com`):

```json
{ "version": "…", "codeHash": "sha256:…", "buildRef": "v…", "deployedAt": "…", "keyId": "h1", "sig": "…" }
```

signed by `HOST_SIG` over `filarr/gate-host/v1|version|` followed by the canonical JSON without `sig`. A security fix
adds `"security": true` and `"advisory": "GHSA-…"`. At each deployment, the service hands it to Filarr's API, which
writes it in the log of every hosted access; Filarr's apps compare `codeHash` with the published release and say "the
same as the published version" or, in red, "different from the published version".

**What that proves, and what it does not.** It proves the service **announces** the code of a published release. No
remote attestation exists on Cloudflare Workers: nobody, Filarr included, can prove to you that the code running is the
code announced. That is why releases go into service only from a signed tag, seven days after publication (except a
security fix, logged as such), why a public log lists them, and why an external security review comes before the
service opens.

## Checking a release yourself

`codeHash` is `sha256:` followed by the SHA-256 of the release's `SHA256SUMS` file. That file lists the two npm
archives **and the service's module**, `host/filarr-gate-host-X.Y.Z.js`, the very file that goes into service
(`wrangler deploy --no-bundle`: nothing is rebuilt at deployment). From a clone, at the release tag:

```sh
npm ci
node scripts/pack-check.mjs release      # builds the archives and the module twice, compares, writes release/SHA256SUMS
sha256sum release/SHA256SUMS             # "sha256:" + this = the codeHash a hosted box announces
curl -s https://ctl.gate.filarr.com/.well-known/filarr-gate-host.json
```

and compare `release/SHA256SUMS` with the `SHA256SUMS` of the GitHub release ([release.md](../release.md)). The
release chain does the same before each deployment: it downloads the published module, checks it against
`SHA256SUMS`, rebuilds it from the tag and compares the bytes.

## The public log of deployments

One line per event in `journal.jsonl`, on the `release-journal` branch of this repository:

- `published`: written by the release chain when it receives the tag, with the time of receipt (never the date the
  tag carries);
- `deployed`: written by `.github/workflows/deploy-host.yml`, at least **seven days** after the `published` entry of the
  same tag; the chain refuses earlier;
- `security`: an accepted security fix, published and deployed at the same moment, with the advisory, its severity and
  the note "security fix, seven-day delay lifted".

The procedure is in [RELEASING.md](../RELEASING.md#the-hosted-service).

## Leaving

Taking the key back to a gate of your own moves the app keys, webhooks and saved queries with the settings package,
switches the identity, erases the hosted copy with a signed receipt, and changes the keys of the databases: see the
[tutorial](../tutorials/hosted-and-back.md#come-back-home).
