# The hosted service, and how to check it yourself

> Coming soon: the box hosted by Filarr is not open. This page says what will be checkable, and what this repository
> does not provide yet. What Filarr can see in that mode, and what protects it: [security and
> trust](../security-and-trust.md#hosted-by-filarr). The move there and back: [tutorial](../tutorials/hosted-and-back.md).

## The same code

The hosted service runs the code of this public repository: the box's core (`packages/server`) through its Cloudflare
adapter (`packages/cloudflare`), one Durable Object per hosted access, in the EU jurisdiction. It adds what only the
service has: opening the sealed token with its own key, signing its requests to Filarr's API, the signed management
channel used by Filarr's apps (no management UI), erasure receipts.

## What a hosted box announces

`https://<name>.gate.filarr.com/.well-known/filarr-gate-host.json`:

```json
{ "version": "…", "codeHash": "sha256:…", "buildRef": "…", "deployedAt": "…", "keyId": "h1", "sig": "…" }
```

signed by the service's key (`HOST_SIG`), whose public half Filarr's apps carry built in and Filarr publishes at
`GET /public/gate-host` (and this repository in `docs/hosted-keys.json`, when the service opens). At each release, the
service also writes it in the log of every hosted access; Filarr's apps compare `codeHash` with the published release
and say "the same as the published version" or, in red, "different from the published version".

**What that proves, and what it does not.** It proves the service **announces** the code of a published release. No
remote attestation exists on Cloudflare Workers: nobody, Filarr included, can prove to you that the code running is the
code announced. That is why releases go into service only from a signed tag, seven days after publication (except a
security fix, logged as such), why a public log lists them, and why an external security review comes before the
service opens.

## Checking a release yourself

What exists today: the npm packages of the library and the command are built reproducibly. From a clone, at the release
tag:

```sh
npm ci
node scripts/pack-check.mjs release     # builds and packs twice, compares, writes release/SHA256SUMS
```

and compare `release/SHA256SUMS` with the `SHA256SUMS` of the GitHub release ([release.md](../release.md)).

What does not exist yet in this repository: the build of the hosted service's own bundle and the computation of its
`codeHash`, so that anyone can rebuild the exact fingerprint a hosted box announces. They must come with the service,
before it opens; until then, the check above covers the packages, not the hosted service.

## Leaving

Taking the key back to a gate of your own moves the app keys, webhooks and saved queries with the settings package,
switches the identity, erases the hosted copy with a signed receipt, and changes the keys of the databases: see the
[tutorial](../tutorials/hosted-and-back.md#come-back-home).
