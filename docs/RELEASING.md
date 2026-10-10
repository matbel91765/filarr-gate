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
2. **First publication only**: trusted publishing can be set on a package that exists. Create a granular access token
   (read and write, packages `@filarr/gate` and `filarr-gate` or all new packages, expiry of a few days) and store it
   as the secret `NPM_TOKEN` of the `release` environment. The chain still publishes with `--provenance`.
3. After the first release, for **each** of the two packages: **Settings › Trusted Publisher › GitHub Actions**,
   organisation or user `matbel91765` (the owner of the repository), repository `filarr-gate`, workflow
   `release.yml`, environment `release`. Then delete the `NPM_TOKEN` secret, revoke the token, and set **Publishing
   access** to "Require two-factor authentication and disallow tokens".

### 6. GHCR: the image name, then a public package

1. Choose the image name and write it at the top of `release.yml` (`IMAGE:`, lowercase). While it reads
   `ghcr.io/OWNER/NAME`, the image job stops with a message and nothing is published after it.
   - `ghcr.io/matbel91765/filarr-gate`: works with the repository as it is;
   - `ghcr.io/filarr/gate`: needs a GitHub organisation `filarr` that owns the repository (the workflow's token can
     only push under its repository's owner); the Filarr app shows this name today.
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
ordinary release and says why in the run summary. Today the chain only checks and publishes: the hosted service's
deployment does not exist yet.

## Check what was published

```sh
npm view @filarr/gate@X.Y.Z dist.integrity
npm view filarr-gate@X.Y.Z dist.integrity
npm pack @filarr/gate@X.Y.Z && sha256sum filarr-gate-X.Y.Z.tgz   # equals library/… in SHA256SUMS
gh release view vX.Y.Z --repo matbel91765/filarr-gate
docker buildx imagetools inspect <IMAGE>:X.Y.Z                    # linux/amd64 and linux/arm64
cosign verify <IMAGE>:X.Y.Z \
  --certificate-identity-regexp '^https://github.com/matbel91765/filarr-gate/\.github/workflows/release\.yml@refs/tags/v' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
git fetch origin release-journal && git show FETCH_HEAD:journal.jsonl | tail -1
```

- The npm pages of both packages show "Provenance" and link the workflow run; in a project that installs them,
  `npm audit signatures` checks the signatures and the attestations.
- The last line of `journal.jsonl` (branch `release-journal`) is the "published" entry: version, tag, commit,
  `codeHash` (`sha256:` + SHA-256 of `SHA256SUMS`) and `publishedAt`, the time the chain received the tag, never the
  date the tag carries. The hosted service's deployment, when it exists, will start from it (seven days later, except
  for an accepted security fix).
