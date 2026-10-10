# Releasing Filarr Gate, step by step

[Lire en français](RELEASING.fr.md)

How the maintainer publishes a version. What a release contains and why is in the [release plan](release.md); this
page is the procedure. Everything runs in GitHub Actions from a **signed tag**: nothing is published from a laptop.

- `.github/workflows/ci.yml`: install, typecheck, tests (never against Filarr's production: a test guard forbids it),
  `docs:check`, reproducible build, on every push and pull request.
- `.github/workflows/release.yml`: on a tag `vX.Y.Z` or `vX.Y.Z-security`, checks the tag's signature against
  `.github/release-signers`, runs the tests again, builds twice and compares (`SHA256SUMS`), publishes `@filarr/gate`
  and `filarr-gate` on npm (provenance, trusted publishing), pushes the multi-architecture image (amd64, arm64) to
  GHCR, creates the GitHub release, and writes the "published" entry of the public release journal.
- `.github/workflows/deploy-host.yml`: started by hand with a published tag, puts the hosted service into service,
  seven days after publication at the earliest ([below](#the-hosted-service)).
- `.github/release-signers`: who may sign a tag, and with which role.

## Once: before the first release

### 1. Merge the release chain into the default branch

The chain reads `.github/release-signers` and `scripts/release/tag-check.mjs` from the **default branch**, never from
the tagged tree: a key added in the same commit as the tag must not be able to sign it. Merge the workflows, the
scripts and the signers file first.

### 2. Create the signing keys

Two Ed25519 SSH keys, each with a passphrase: one for ordinary releases, one, kept apart, for security fixes.

```sh
ssh-keygen -t ed25519 -C "filarr-gate release" -f ~/.ssh/filarr-gate-release
ssh-keygen -t ed25519 -C "filarr-gate security" -f ~/.ssh/filarr-gate-security
```

### 3. Declare them in GitHub and in `release-signers`

- GitHub: **Settings › SSH and GPG keys › New SSH key**, key type **Signing Key**, paste the content of
  `~/.ssh/filarr-gate-release.pub` (then the same for the security key). GitHub then shows the tag as "Verified".
- The repository: in `.github/release-signers`, one line per key, without the leading `#`:

  ```text
  release:<name> namespaces="git" ssh-ed25519 AAAA…
  security:<name> namespaces="git" ssh-ed25519 AAAA…
  ```

  `cut -d' ' -f1,2 ~/.ssh/filarr-gate-release.pub` prints the `ssh-ed25519 AAAA…` part. One key never holds both
  roles. Commit to the default branch, through a reviewed change.

- Your local git, to sign and check tags:

  ```sh
  git config gpg.format ssh
  git config user.signingkey "$HOME/.ssh/filarr-gate-release.pub"
  git config gpg.ssh.allowedSignersFile .github/release-signers
  ```

### 4. Protect the tags and the release environment

- **Settings › Rules › Rulesets › New tag ruleset**: target `v*`, restrict creation, update and deletion, bypass
  for the maintainer only. The workflow that runs is the one in the tagged commit: who can push a tag must be limited.
- **Settings › Environments › New environment** `release`: deployment branches and tags "Selected", rule `v*`. The
  npm and image jobs run in this environment; npm's trusted publishing is tied to it (step 5).

### 5. npm: the `@filarr` organisation and trusted publishing

1. On npmjs.com, with two-factor authentication on: create the organisation `filarr` (free plan, public packages),
   which owns the scope `@filarr`. Check that the unscoped name `filarr-gate` is free.

   If the organisation `filarr` cannot be created on npm (name taken), choose another scope, for example
   `@filarr-work`, and rename the library everywhere before the first release: `name` in
   `packages/gate/package.json` (and the lock file: `npm install --package-lock-only --legacy-peer-deps`), the pair
   `"@filarr/gate:release/a/library"` in `release.yml` and its test (`test/workflows.test.ts`), the imports
   `from '@filarr/gate'` of the documentation, the examples (`examples/library-node`) and the READMEs. What the
   library reports to Filarr (`lib-<version>`) does not change, and the command `filarr-gate`, unscoped, keeps its
   name. Filarr's apps show `npm install @filarr/gate`: their text changes too.
2. **First publication only**: trusted publishing can be set on a package that exists. Create a granular access token
   (read and write, packages `@filarr/gate` and `filarr-gate` or all new packages, expiry of a few days) and store it
   as the secret `NPM_TOKEN` of the `release` environment. The chain still publishes with `--provenance`.
3. After the first release, for **each** of the two packages: **Settings › Trusted Publisher › GitHub Actions**,
   organisation `filarr-work` (the owner of the repository), repository `filarr-gate`, workflow
   `release.yml`, environment `release`. Then delete the `NPM_TOKEN` secret, revoke the token, and set **Publishing
   access** to "Require two-factor authentication and disallow tokens".

### 6. GHCR: the image, then a public package

1. The image is `ghcr.io/filarr-work/gate`, written at the top of `release.yml` (`IMAGE:`). The workflow's token
   only pushes under the owner of its repository: the repository must be in the organisation `filarr-work`
   (`https://github.com/filarr-work/filarr-gate`) before the first release. To change the name, edit `IMAGE:`
   (lowercase); a name left at the template `ghcr.io/OWNER/NAME` stops the image job.
2. After the first push: the package page on GitHub › **Package settings › Change visibility › Public**. Check that
   the package is linked to the repository (the image's `org.opencontainers.image.source` label does it).

### 7. Optional: reading a private security advisory

A security fix names a GitHub advisory that is still private when the tag is pushed. The workflow's own token cannot
read it, so the chain would treat the fix as an ordinary release. To let it check the advisory, create a fine-grained
token with **Repository security advisories: read** on this repository only, stored as the repository secret
`ADVISORY_READ_TOKEN`.

## Each release

### 1. Prepare

The version is set by the maintainer in `packages/gate/package.json` and `packages/cli/package.json` (and the private
packages, to keep them aligned). The chain refuses a tag whose version differs from these two files. Then, on a clean
tree of the default branch:

```sh
npm ci
npm run typecheck
npm test
npm run docs:check
node scripts/pack-check.mjs release
```

### 2. Tag, signed

```sh
git tag -s vX.Y.Z -m "Filarr Gate X.Y.Z"
git tag -v vX.Y.Z           # Good "git" signature for release:<name>
git push origin vX.Y.Z
```

An unsigned or lightweight tag, a tag signed by a key that is not in `release-signers` (read from the default
branch), or a name other than `vX.Y.Z` / `vX.Y.Z-security`, is refused: nothing is built or published.

### 3. A security fix (`vX.Y.Z-security`)

Only for a flaw that puts at stake the confidentiality or integrity of entrusted databases, their keys, the tokens or
the isolation, described in a GitHub security advisory of this repository (draft first). From a maintenance branch
that starts at the last version in service, with the fix only:

```sh
git -c user.signingkey="$HOME/.ssh/filarr-gate-security.pub" tag -s vX.Y.Z-security \
  -m "Filarr Gate X.Y.Z: security fix" \
  -m "Filarr-Release-Kind: security
Filarr-Advisory: GHSA-xxxx-xxxx-xxxx"
git push origin vX.Y.Z-security
```

The two lines must be the last paragraph of the message. The package version stays `X.Y.Z`. If one condition is
missing (the `release` key signed it, a line is missing, the advisory cannot be read), the chain publishes it as an
ordinary release and says why in the run summary. Publishing does not put the hosted service into service: that is
[`deploy-host.yml`](#the-hosted-service), started by hand.

## Check what was published

```sh
npm view @filarr/gate@X.Y.Z dist.integrity
npm view filarr-gate@X.Y.Z dist.integrity
npm pack @filarr/gate@X.Y.Z && sha256sum filarr-gate-X.Y.Z.tgz   # equals library/… in SHA256SUMS
gh release view vX.Y.Z --repo filarr-work/filarr-gate
docker buildx imagetools inspect ghcr.io/filarr-work/gate:X.Y.Z                    # linux/amd64 and linux/arm64
cosign verify ghcr.io/filarr-work/gate:X.Y.Z \
  --certificate-identity-regexp '^https://github.com/filarr-work/filarr-gate/\.github/workflows/release\.yml@refs/tags/v' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
git fetch origin release-journal && git show FETCH_HEAD:journal.jsonl | tail -1
```

- The npm pages of both packages show "Provenance" and link the workflow run; in a project that installs them,
  `npm audit signatures` checks the signatures and the attestations.
- The last line of `journal.jsonl` (branch `release-journal`) is the "published" entry: version, tag, commit,
  `codeHash` (`sha256:` + SHA-256 of `SHA256SUMS`) and `publishedAt`, the time the chain received the tag, never the
  date the tag carries. The hosted service's deployment starts from it (seven days later, except for an accepted
  security fix).

## The hosted service

The hosted box runs as the Worker script `filarr-gate-host` (`packages/host`) in the Cloudflare account of Filarr's
API, isolated by script. How it is mounted and what it guarantees: [the hosted service](explain/hosted.md). It goes
into service **only** through `.github/workflows/deploy-host.yml`, from a signed tag published at least seven days
earlier (except an accepted security fix): never from a laptop, and the Cloudflare deployment token exists only in that
workflow.

### Once: in Cloudflare (the account of the API, zone `filarr.com`)

1. **People.** Keep the account's members to the minimum, two-factor authentication required for all. No API token
   able to deploy Workers may exist outside the chain (check **My Profile › API Tokens** of every member).
2. **Certificate.** **SSL/TLS › Edge Certificates › Order an advanced certificate**, hostname `*.gate.filarr.com`
   (Advanced Certificate Manager, paid). The universal certificate covers `*.filarr.com`, not `*.gate.filarr.com`.
3. **DNS.** A proxied record (orange cloud) named `*.gate`, for example `AAAA *.gate 100::`: the Worker route answers in
   front of it, the address itself is never reached.
4. **Zone rules for `*.gate.filarr.com`** (expression `http.host wildcard "*.gate.filarr.com"`), so that a program
   calling a box receives JSON and never a challenge, and that no request is kept:
   - **Security › WAF › Custom rules**: one rule, action **Skip** (all remaining custom rules, all managed rules, and
     Super Bot Fight Mode rules when the plan has them), **Log matching requests unchecked**;
   - **Rules › Configuration Rules**: Browser Integrity Check off, Security Level "Essentially Off", JavaScript
     detections off where the plan exposes the setting, Email Obfuscation and Rocket Loader off;
   - **Bot Fight Mode** (free plan) cannot be skipped by hostname: it must be off for the zone (or replaced by Super
     Bot Fight Mode with the skip above);
   - no Logpush job that covers these names, and no other Worker route on `*.gate.filarr.com/*`.
   A daily read-only check of these rules and of the route belongs to Filarr's operations (contract § 10.3); it is not
   in this repository.
5. **The deployment token.** **My Profile › API Tokens › Create Token › Custom token**: *Account › Workers Scripts ›
   Edit* on the API's account, *Zone › Workers Routes › Edit* on `filarr.com`, nothing else. Copy it once into GitHub
   (next section) and nowhere else.
6. **The service's keys**, from a clean clone of the default branch, logged in to that account (`npx wrangler login`):

   ```sh
   node scripts/host-keys.mjs
   npx wrangler secret put FILARR_API_URL --name filarr-gate-host     # value: https://api.filarr.com
   ```

   `host-keys.mjs` draws `HOST_ENC` (X25519) and `HOST_SIG` (Ed25519) in memory, hands each private key to
   `wrangler secret put … --name filarr-gate-host` through standard input (never on the command line, on disk or on
   screen), then adds the public entry to `docs/hosted-keys.json` and prints it. Run it **once**. There is no copy of
   the private keys: lost, they are replaced by a rotation. If the script does not exist yet in the account, wrangler
   creates it empty when it stores the first secret; its code only ever arrives through the chain.
7. **Then**: commit `docs/hosted-keys.json` to the default branch through a reviewed change (the service embeds this
   list: the first deployable release must be tagged **after** this commit); give the printed list to Filarr's API
   (variable `GATE_HOST_SIGN_KEYS`, with `GATE_HOST_DOMAIN = gate.filarr.com` and `GATE_HOST_CONTROL_URL =
   https://ctl.gate.filarr.com`) and to Filarr's apps (`GATE_HOST_KEYS`).

### Once: in GitHub

- **Settings › Environments › New environment** `host-deploy`: deployment branches "Selected branches", rule `main`
  only (the workflow also refuses to run from another branch). A required reviewer can be added as a last check before
  each deployment.
- In that environment: the secret `CLOUDFLARE_API_TOKEN` (the token of step 5) and the variable
  `CLOUDFLARE_ACCOUNT_ID` (the account of the API, shown on its overview page). Nowhere else: no repository secret, no
  other environment.
- `ADVISORY_READ_TOKEN` (step 7 above) is also read by the deployment, to check a security advisory and read its
  severity.

### Each deployment

1. A release made by `release.yml` that contains the service's module: its `SHA256SUMS` lists
   `host/filarr-gate-host-X.Y.Z.js`. Releases made before the module existed (0.2.0) cannot be deployed.
2. At least seven days after its `published` entry in `journal.jsonl` (branch `release-journal`).
3. **Actions › Deploy hosted service › Run workflow**, from `main`, with the tag `vX.Y.Z`.

The workflow checks the tag's signature against `release-signers` of the default branch (twice), finds the
`published` entry of the tag, downloads the release's `SHA256SUMS` and the module, checks the module against it and the
`codeHash` against the journal, refuses before seven days, runs the tests on the tagged commit and rebuilds the module
byte for byte, deploys **that** file (`wrangler deploy --no-bundle`) with `HOST_CODE_HASH`, `HOST_BUILD_REF` and
`HOST_DEPLOYED_AT`, reads back the announcement served at `https://ctl.gate.filarr.com/.well-known/filarr-gate-host.json`,
and writes the `deployed` entry of the journal. Within five minutes, the service hands its version announcement to
Filarr's API, which writes it in the log of every hosted access. Read the Cloudflare account's audit log after each
deployment.

**A security fix.** Tag `vX.Y.Z-security` as above (step "A security fix"), from a maintenance branch that starts at
the commit of the last version in service, and run the same workflow with that tag as soon as `release.yml` has
published it. The deployment goes ahead without delay only if the tag-check accepts the fix (key of role `security`,
the two lines, existing advisory), a version is in service and the tagged commit descends from it, and the advisory's
severity can be read; the journal then gets a `security` entry (published and deployed at the same moment, the
advisory, its severity, "security fix, seven-day delay lifted") and every hosted access is told. One condition missing:
it is an ordinary release, seven days.

**Rotating the service's keys.** `node scripts/host-keys.mjs --rotate --id h2 --not-before <date at least 60 days
later>` adds `HOST_ENC_h2` and `HOST_SIG_h2` and the new public entry; the new key enters a version of Filarr's apps
at least 60 days before its `notBefore`. The old private keys stay: they open the tokens already sealed to them.
