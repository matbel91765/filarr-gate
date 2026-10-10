# Plan de publication

[Read in English](release.md)

Ce que publie une version, dans quel ordre, et comment chacun peut vérifier que ce qui a été publié est bien ce que ce
dépôt construit. La première publication est la **0.2.0** ; comment le mainteneur publie, pas à pas :
[RELEASING.fr.md](RELEASING.fr.md).

## Ce qui est publié

| artefact | depuis | où |
|---|---|---|
| `@filarr/gate` (bibliothèque) | `packages/gate` (`dist/`, `README.md`, `LICENSE`, `NOTICE`) | npm |
| `filarr-gate` (commande, serveur, interface) | `packages/cli` (`dist/cli.js`, `dist/ui/`, les README aux liens absolus, `SECURITY.md`, `THIRD_PARTY_NOTICES`) | npm |
| image Docker | `Dockerfile` | GitHub Container Registry |
| variante Cloudflare | les sources étiquetées (`wrangler.jsonc`, `packages/cloudflare`) | le bouton Deploy pointe vers le dépôt |
| sommes de contrôle et attestations | `SHA256SUMS`, provenance npm, provenance et SBOM de l'image | version publiée sur GitHub, à l'étiquette |

`packages/core`, `packages/server` et `packages/cloudflare` sont privés : embarqués, jamais publiés seuls.
`packages/host` (le service hébergé) est privé lui aussi : son module est joint à la publication GitHub et n'est mis
en service que par la chaîne de publication.

## Les versions

Une seule version pour tout le dépôt, fixée par le mainteneur seulement, dans `packages/gate/package.json`,
`packages/cli/package.json` (et les paquets privés, pour les garder alignés). La bibliothèque la déclare à Filarr sous
la forme `lib-<version>`, le serveur sous la forme `<version>`. Cette publication : **0.3.0**.

## Avant d'étiqueter

```sh
git status                    # propre
npm ci
npm run typecheck
npm test                      # comprend les vecteurs de référence, wrangler dev et PostgreSQL quand ils sont là
npm run test:e2e              # face au worker Filarr local du banc de Filarr (voir test/worker.e2e.test.ts)
node scripts/pack-check.mjs release   # construit et empaquette deux fois, compare, écrit release/SHA256SUMS
```

Vérifiez aussi :

- `packages/core/src/PROVENANCE.json` : le cœur recopié correspond au commit de Filarr qu'il nomme
  (`scripts/copy-core.mjs` lancé sur ce commit laisse l'arbre inchangé), et les vecteurs recopiés de Filarr sont
  identiques aux siens.
- Les vecteurs dont ce dépôt est l'origine (`source-externe-1`, `gate-fichiers-1`, `gate-settings-1`,
  `gate-heberge-1-gate`) sont inchangés, ou leur changement a d'abord été convenu avec les applis Filarr (règle de
  parité).

## Des constructions reproductibles

- Les dépendances sont figées par `package-lock.json` et installées par `npm ci`.
- Les paquets construits (esbuild, Vite) ne portent ni date ni chemin absolu ; `npm pack` écrit des horodatages fixes
  et un ordre stable. `scripts/pack-check.mjs` construit et empaquette deux fois et échoue si les archives diffèrent ;
  lancez-le sur deux machines (ou en CI et en local) et comparez `SHA256SUMS`.
- L'image Docker : l'image de base est figée par son empreinte (`NODE_IMAGE` en tête du `Dockerfile`, qui dit comment
  la mettre à jour), les actions de la chaîne par SHA de commit ; construire avec `SOURCE_DATE_EPOCH` réglé sur l'heure du commit de l'étiquette (la chaîne de publication
  s'en charge), avec provenance et SBOM. Réécrire l'horodatage des couches (`--output
  type=image,rewrite-timestamp=true`) est *à faire* une fois vérifié sur un envoi d'essai.

## Publier (dans cet ordre)

Tout cela est `.github/workflows/release.yml` ; la marche à suivre du mainteneur, pas à pas, est
[RELEASING.fr.md](RELEASING.fr.md).

1. Poser l'étiquette `v<version>` sur `main`, signée par une clé de `.github/release-signers` (signature SSH de git).
2. Depuis GitHub Actions seulement (OIDC, aucun jeton de longue durée) : `npm publish --provenance --access public`
   des deux archives que `scripts/pack-check.mjs` a construites et comparées, `@filarr/gate` puis `filarr-gate`. Les
   scripts `prepack` recopient les fichiers de licence dans chaque paquet.
3. L'image, depuis le même flux de travail : étiquettes `<version>`, `<major>.<minor>`, `<major>` à partir de la 1.0
   et `latest` pour une étiquette de la branche par défaut seulement (jamais un correctif de maintenance), signée avec
   cosign (sans clé), avec sa provenance et son SBOM.
4. La version publiée sur GitHub : notes, `SHA256SUMS`, les deux archives `.tgz` et le module du service hébergé
   (`filarr-gate-host-<version>.js`, construit deux fois et comparé comme les archives) ; puis l'entrée « published »
   du journal public des mises en service (branche `release-journal`). Le service hébergé entre en service plus tard,
   à la main, depuis ce module ([RELEASING.fr.md](RELEASING.fr.md#le-service-hébergé)).
5. Vérifier : `npm view @filarr/gate dist.integrity` comparé à l'archive ; `npm audit signatures` ; `cosign verify` sur
   l'image ; le bouton Deploy sur un compte d'essai (jamais celui de production du mainteneur).

## Les noms

- **Image.** `ghcr.io/filarr-work/gate` : `:0.3.0`, `:0.3` (suit les correctifs 0.3.x) et `latest` ; `:<majeure>` à
  partir de la 1.0.
- **Volume.** `/data`, comme dans l'appli Filarr.
- **npm.** `@filarr/gate` (la bibliothèque) et `filarr-gate` (la commande). Si la portée change un jour, ce qu'il faut
  renommer : [RELEASING.fr.md](RELEASING.fr.md#5-npm--lorganisation-filarr-et-la-publication-de-confiance).
