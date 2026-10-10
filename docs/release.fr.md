# Plan de publication

[Read in English](release.md)

Ce que publie une version, dans quel ordre, et comment chacun peut vérifier que ce qui a été publié est bien ce que ce
dépôt construit. **Rien n'est encore publié** ; les étapes marquées *décision* attendent le mainteneur.

## Ce qui est publié

| artefact | depuis | où |
|---|---|---|
| `@filarr/gate` (bibliothèque) | `packages/gate` (`dist/`, `README.md`, `LICENSE`, `NOTICE`) | npm |
| `filarr-gate` (commande, serveur, interface) | `packages/cli` (`dist/cli.js`, `dist/ui/`, les README, `SECURITY.md`) | npm |
| image Docker | `Dockerfile` | GitHub Container Registry |
| variante Cloudflare | les sources étiquetées (`wrangler.jsonc`, `packages/cloudflare`) | le bouton Deploy pointe vers le dépôt |
| sommes de contrôle et attestations | `SHA256SUMS`, provenance npm, provenance et SBOM de l'image | version publiée sur GitHub, à l'étiquette |

`packages/core`, `packages/server` et `packages/cloudflare` sont privés : embarqués, jamais publiés seuls.

## Les versions

Une seule version pour tout le dépôt, fixée par le mainteneur seulement, dans `packages/gate/package.json`,
`packages/cli/package.json` (et les paquets privés, pour les garder alignés). La bibliothèque la déclare à Filarr sous
la forme `lib-<version>`, le serveur sous la forme `<version>`. Cette publication : **0.2.0**.

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
4. La version publiée sur GitHub : notes, `SHA256SUMS`, les deux archives `.tgz` ; puis l'entrée « published » du
   journal public des mises en service (branche `release-journal`).
5. Vérifier : `npm view @filarr/gate dist.integrity` comparé à l'archive ; `npm audit signatures` ; `cosign verify` sur
   l'image ; le bouton Deploy sur un compte d'essai (jamais celui de production du mainteneur).

## Les décisions qui attendent le mainteneur

- **Nom de l'image.** Décidé : `ghcr.io/filarr-work/gate`, le dépôt passant dans l'organisation GitHub `filarr-work`.
  L'appli Filarr affiche encore `ghcr.io/filarr/gate:1` : son texte doit changer.
- **Étiquette de l'image.** `:1` n'existe pas avant une 1.0 ; d'ici là, l'appli devrait afficher
  `ghcr.io/filarr-work/gate:0.2`.
- **Volume.** Aligné sur l'appli : `/data` (c'était `/var/lib/filarr-gate` en 0.1, jamais publiée).
- **Portée npm.** `@filarr` doit être une organisation npm détenue par le mainteneur avant la première publication ;
  sinon, ce qu'il faut renommer : [RELEASING.fr.md](RELEASING.fr.md#5-npm--lorganisation-filarr-et-la-publication-de-confiance).
