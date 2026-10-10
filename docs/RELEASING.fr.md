# Publier Filarr Gate, pas à pas

[Read in English](RELEASING.md)

Comment le mainteneur publie une version. Ce que contient une version et pourquoi est dans le
[plan de publication](release.fr.md) ; cette page est la marche à suivre. Tout se passe dans GitHub Actions, à partir
d'une **étiquette signée** : rien n'est publié depuis un poste.

- `.github/workflows/ci.yml` : installation, typage, essais (jamais contre la production de Filarr : une garde des
  essais l'interdit), `docs:check`, construction reproductible, à chaque envoi et à chaque demande de fusion.
- `.github/workflows/release.yml` : sur une étiquette `vX.Y.Z` ou `vX.Y.Z-security`, vérifie la signature de
  l'étiquette contre `.github/release-signers`, relance les essais, construit deux fois et compare (`SHA256SUMS`),
  publie `@filarr/gate` et `filarr-gate` sur npm (provenance, publication de confiance), pousse l'image
  multi-architecture (amd64, arm64) sur GHCR, crée la publication GitHub, et écrit l'entrée « published » du journal
  public des mises en service.
- `.github/release-signers` : qui peut signer une étiquette, et avec quel rôle.

## Une fois : avant la première publication

### 1. Fusionner la chaîne de publication dans la branche par défaut

La chaîne lit `.github/release-signers` et `scripts/release/tag-check.mjs` sur la **branche par défaut**, jamais dans
l'arbre de l'étiquette : une clé ajoutée dans le même commit que l'étiquette ne doit pas pouvoir la signer. Fusionnez
d'abord les workflows, les scripts et le fichier des signataires.

### 2. Créer les clés de signature

Deux clés SSH Ed25519, chacune avec une phrase de passe : l'une pour les publications ordinaires, l'autre, à part,
pour les correctifs de sécurité.

```sh
ssh-keygen -t ed25519 -C "filarr-gate release" -f ~/.ssh/filarr-gate-release
ssh-keygen -t ed25519 -C "filarr-gate security" -f ~/.ssh/filarr-gate-security
```

### 3. Les déclarer dans GitHub et dans `release-signers`

- GitHub : **Settings › SSH and GPG keys › New SSH key**, type de clé **Signing Key**, collez le contenu de
  `~/.ssh/filarr-gate-release.pub` (puis de même pour la clé de sécurité). GitHub montre alors l'étiquette
  « Verified ».
- Le dépôt : dans `.github/release-signers`, une ligne par clé, sans le `#` de tête :

  ```text
  release:<nom> namespaces="git" ssh-ed25519 AAAA…
  security:<nom> namespaces="git" ssh-ed25519 AAAA…
  ```

  `cut -d' ' -f1,2 ~/.ssh/filarr-gate-release.pub` affiche la partie `ssh-ed25519 AAAA…`. Une même clé ne tient
  jamais les deux rôles. Commit sur la branche par défaut, par un changement relu.

- Votre git local, pour signer et vérifier les étiquettes :

  ```sh
  git config gpg.format ssh
  git config user.signingkey "$HOME/.ssh/filarr-gate-release.pub"
  git config gpg.ssh.allowedSignersFile .github/release-signers
  ```

### 4. Protéger les étiquettes et l'environnement de publication

- **Settings › Rules › Rulesets › New tag ruleset** : cible `v*`, création, modification et suppression restreintes,
  exception pour le seul mainteneur. Le workflow qui tourne est celui du commit étiqueté : qui peut pousser une
  étiquette doit être limité.
- **Settings › Environments › New environment** `release` : branches et étiquettes de déploiement « Selected »,
  règle `v*`. Les travaux npm et image tournent dans cet environnement ; la publication de confiance de npm y est
  liée (étape 5).

### 5. npm : l'organisation `@filarr` et la publication de confiance

1. Sur npmjs.com, double authentification activée : créez l'organisation `filarr` (offre gratuite, paquets publics),
   à qui appartient la portée `@filarr`. Vérifiez que le nom sans portée `filarr-gate` est libre.
2. **Première publication seulement** : la publication de confiance se règle sur un paquet qui existe. Créez un jeton
   d'accès granulaire (lecture et écriture, paquets `@filarr/gate` et `filarr-gate` ou tous les nouveaux paquets,
   expiration de quelques jours) et rangez-le dans le secret `NPM_TOKEN` de l'environnement `release`. La chaîne
   publie quand même avec `--provenance`.
3. Après la première publication, pour **chacun** des deux paquets : **Settings › Trusted Publisher › GitHub
   Actions**, organisation ou utilisateur `matbel91765` (le propriétaire du dépôt), dépôt `filarr-gate`, workflow
   `release.yml`, environnement `release`. Supprimez ensuite le secret `NPM_TOKEN`, révoquez le jeton, et réglez
   **Publishing access** sur « Require two-factor authentication and disallow tokens ».

### 6. GHCR : le nom de l'image, puis un paquet public

1. Choisissez le nom de l'image et écrivez-le en tête de `release.yml` (`IMAGE:`, en minuscules). Tant qu'il vaut
   `ghcr.io/OWNER/NAME`, le travail de l'image s'arrête sur un message et rien n'est publié après lui.
   - `ghcr.io/matbel91765/filarr-gate` : marche avec le dépôt tel qu'il est ;
   - `ghcr.io/filarr/gate` : demande une organisation GitHub `filarr` propriétaire du dépôt (le jeton du workflow ne
     pousse que sous le propriétaire de son dépôt) ; c'est le nom que montre l'appli Filarr aujourd'hui.
2. Après le premier envoi : la page du paquet sur GitHub › **Package settings › Change visibility › Public**.
   Vérifiez que le paquet est lié au dépôt (l'étiquette `org.opencontainers.image.source` de l'image s'en charge).

### 7. Facultatif : lire un avis de sécurité encore privé

Un correctif de sécurité nomme un avis GitHub encore privé au moment où l'étiquette est poussée. Le jeton propre au
workflow ne peut pas le lire : la chaîne traiterait alors le correctif en publication ordinaire. Pour qu'elle vérifie
l'avis, créez un jeton à portée fine avec **Repository security advisories: read** sur ce seul dépôt, rangé dans le
secret de dépôt `ADVISORY_READ_TOKEN`.

## À chaque publication

### 1. Préparer

La version est fixée par le mainteneur dans `packages/gate/package.json` et `packages/cli/package.json` (et les
paquets privés, pour rester alignés). La chaîne refuse une étiquette dont la version diffère de ces deux fichiers.
Puis, sur un arbre propre de la branche par défaut :

```sh
npm ci
npm run typecheck
npm test
npm run docs:check
node scripts/pack-check.mjs release
```

### 2. L'étiquette, signée

```sh
git tag -s vX.Y.Z -m "Filarr Gate X.Y.Z"
git tag -v vX.Y.Z           # Good "git" signature for release:<nom>
git push origin vX.Y.Z
```

Une étiquette non signée ou légère, signée par une clé absente de `release-signers` (lu sur la branche par défaut),
ou d'un autre nom que `vX.Y.Z` / `vX.Y.Z-security`, est refusée : rien n'est construit ni publié.

### 3. Un correctif de sécurité (`vX.Y.Z-security`)

Seulement pour une faille qui met en jeu la confidentialité ou l'intégrité des bases confiées, de leurs clés, des
jetons ou de l'isolement, décrite dans un avis de sécurité GitHub de ce dépôt (d'abord en brouillon). Depuis une
branche de maintenance qui part de la dernière version en service, avec le correctif seul :

```sh
git -c user.signingkey="$HOME/.ssh/filarr-gate-security.pub" tag -s vX.Y.Z-security \
  -m "Filarr Gate X.Y.Z : correctif de sécurité" \
  -m "Filarr-Release-Kind: security
Filarr-Advisory: GHSA-xxxx-xxxx-xxxx"
git push origin vX.Y.Z-security
```

Les deux lignes forment le dernier paragraphe du message. La version des paquets reste `X.Y.Z`. Si une condition
manque (la clé `release` l'a signée, une ligne manque, l'avis est illisible), la chaîne la publie comme une version
ordinaire et dit pourquoi dans le résumé du passage. Aujourd'hui, la chaîne ne fait que vérifier et publier : la mise
en service du service hébergé n'existe pas encore.

## Vérifier ce qui est publié

```sh
npm view @filarr/gate@X.Y.Z dist.integrity
npm view filarr-gate@X.Y.Z dist.integrity
npm pack @filarr/gate@X.Y.Z && sha256sum filarr-gate-X.Y.Z.tgz   # égal à library/… dans SHA256SUMS
gh release view vX.Y.Z --repo matbel91765/filarr-gate
docker buildx imagetools inspect <IMAGE>:X.Y.Z                    # linux/amd64 et linux/arm64
cosign verify <IMAGE>:X.Y.Z \
  --certificate-identity-regexp '^https://github.com/matbel91765/filarr-gate/\.github/workflows/release\.yml@refs/tags/v' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
git fetch origin release-journal && git show FETCH_HEAD:journal.jsonl | tail -1
```

- Les pages npm des deux paquets affichent « Provenance » et renvoient au passage du workflow ; dans un projet qui les
  installe, `npm audit signatures` vérifie les signatures et les attestations.
- La dernière ligne de `journal.jsonl` (branche `release-journal`) est l'entrée « published » : version, étiquette,
  commit, `codeHash` (`sha256:` + SHA-256 de `SHA256SUMS`) et `publishedAt`, l'heure à laquelle la chaîne a reçu
  l'étiquette, jamais la date que porte l'étiquette. La mise en service du service hébergé, quand elle existera,
  partira de là (sept jours plus tard, sauf pour un correctif de sécurité accepté).
