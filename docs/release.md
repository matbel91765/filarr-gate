# Release plan

[Lire en français](release.fr.md)

What a release publishes, in which order, and how anyone can check that what was published is what this repository
builds. **Nothing here has been published yet**; the steps marked *decision* wait for the maintainer.

## What is published

| artifact | from | where |
|---|---|---|
| `@filarr/gate` (library) | `packages/gate` (`dist/`, `README.md`, `LICENSE`, `NOTICE`) | npm |
| `filarr-gate` (command, server, UI) | `packages/cli` (`dist/cli.js`, `dist/ui/`, READMEs, `SECURITY.md`) | npm |
| Docker image | `Dockerfile` | GitHub Container Registry |
| Cloudflare variant | the tagged source (`wrangler.jsonc`, `packages/cloudflare`) | the Deploy button points at the repository |
| checksums and attestations | `SHA256SUMS`, npm provenance, image provenance and SBOM | GitHub release of the tag |

`packages/core`, `packages/server` and `packages/cloudflare` are private: bundled, never published on their own.

## Versions

One version for the whole repository, set by the maintainer only (*decision*), in `packages/gate/package.json`,
`packages/cli/package.json` (and the private packages, to keep them aligned). The library reports it as
`lib-<version>` to Filarr, the server as `<version>`. Proposed for this release: **0.2.0**.

## Before tagging

```sh
git status                    # clean
npm ci
npm run typecheck
npm test                      # includes the golden vectors, wrangler dev and PostgreSQL when present
npm run test:e2e              # against the local Filarr worker of the Filarr bench (see test/worker.e2e.test.ts)
node scripts/pack-check.mjs release   # builds and packs twice, compares, writes release/SHA256SUMS
```

Also check:

- `packages/core/src/PROVENANCE.json`: the copied core matches the Filarr commit it names (`scripts/copy-core.mjs` run
  against that commit leaves the tree unchanged), and the vectors copied from Filarr are identical to theirs.
- The vectors this repository originates (`source-externe-1`, `gate-fichiers-1`, `gate-settings-1`) are unchanged, or
  their change is agreed with the Filarr apps first (parity rule).

## Reproducible builds

- Dependencies are pinned by `package-lock.json` and installed with `npm ci`.
- The bundles (esbuild, Vite) carry no date and no absolute path; `npm pack` writes fixed timestamps and a stable
  order. `scripts/pack-check.mjs` builds and packs twice and fails if the archives differ; run it on two machines (or
  in CI and locally) and compare `SHA256SUMS`.
- The Docker image: pin the base image by digest (`node:22-alpine@sha256:…`, *to do at release time*), build with
  `SOURCE_DATE_EPOCH` set to the tag's commit time and `docker buildx build --build-arg SOURCE_DATE_EPOCH
  --output type=image,rewrite-timestamp=true --provenance=true --sbom=true`.

## Publishing (in this order)

1. Tag `v<version>` on `main`, signed.
2. From GitHub Actions only (OIDC, no long-lived token): `npm publish --provenance --access public -w @filarr/gate`
   then `-w filarr-gate`. The `prepack` scripts copy the licence files into each package.
3. The image, from the same workflow: tags `<version>`, `<major>.<minor>`, `<major>` (and `latest`), signed with
   cosign (keyless), with its provenance and SBOM.
4. The GitHub release: notes, `SHA256SUMS` (signed), the two `.tgz` archives.
5. Check: `npm view @filarr/gate dist.integrity` against the archive; `npm audit signatures`; `cosign verify` on the
   image; the Deploy button on a test account (never the maintainer's production one).

## Decisions waiting for the maintainer

- **Image name.** The Filarr app shows `ghcr.io/filarr/gate:1`. Publishing there needs a GitHub organisation `filarr`
  owning the package; otherwise the natural name is `ghcr.io/matbel91765/filarr-gate`, and the app text changes.
- **Image tag.** `:1` does not exist before a 1.0; until then the app should show `:0.2` (or `:0`).
- **Volume.** Aligned on the app: `/data` (it was `/var/lib/filarr-gate` in 0.1, never published).
- **npm scope.** `@filarr` must be an npm organisation owned by the maintainer before the first publish.
