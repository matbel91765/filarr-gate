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
- `.github/workflows/deploy-host.yml` : lancé à la main avec une étiquette publiée, met le service hébergé en
  service, sept jours après la publication au plus tôt ([plus bas](#le-service-hébergé)).
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

   Si l'organisation `filarr` ne peut pas être créée sur npm (nom pris), choisissez une autre portée, par exemple
   `@filarr-work`, et renommez la bibliothèque partout avant la première publication : `name` dans
   `packages/gate/package.json` (et le fichier de verrouillage : `npm install --package-lock-only --legacy-peer-deps`),
   la paire `"@filarr/gate:release/a/library"` dans `release.yml` et son essai (`test/workflows.test.ts`), les imports
   `from '@filarr/gate'` de la documentation, des exemples (`examples/library-node`) et des README. Ce que la
   bibliothèque annonce à Filarr (`lib-<version>`) ne change pas, et la commande `filarr-gate`, sans portée, garde son
   nom. Les applis Filarr affichent `npm install @filarr/gate` : leur texte change aussi.
2. **Première publication seulement** : la publication de confiance se règle sur un paquet qui existe. Créez un jeton
   d'accès granulaire (lecture et écriture, paquets `@filarr/gate` et `filarr-gate` ou tous les nouveaux paquets,
   expiration de quelques jours) et rangez-le dans le secret `NPM_TOKEN` de l'environnement `release`. La chaîne
   publie quand même avec `--provenance`.
3. Après la première publication, pour **chacun** des deux paquets : **Settings › Trusted Publisher › GitHub
   Actions**, organisation `filarr-work` (le propriétaire du dépôt), dépôt `filarr-gate`, workflow
   `release.yml`, environnement `release`. Supprimez ensuite le secret `NPM_TOKEN`, révoquez le jeton, et réglez
   **Publishing access** sur « Require two-factor authentication and disallow tokens ».

### 6. GHCR : l'image, puis un paquet public

1. L'image est `ghcr.io/filarr-work/gate`, écrite en tête de `release.yml` (`IMAGE:`). Le jeton du workflow ne pousse
   que sous le propriétaire de son dépôt : le dépôt doit être dans l'organisation `filarr-work`
   (`https://github.com/filarr-work/filarr-gate`) avant la première publication. Pour changer de nom, modifiez
   `IMAGE:` (en minuscules) ; un nom resté au modèle `ghcr.io/OWNER/NAME` arrête le travail de l'image.
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
ordinaire et dit pourquoi dans le résumé du passage. Publier ne met pas le service hébergé en service : c'est
[`deploy-host.yml`](#le-service-hébergé), lancé à la main.

## Vérifier ce qui est publié

```sh
npm view @filarr/gate@X.Y.Z dist.integrity
npm view filarr-gate@X.Y.Z dist.integrity
npm pack @filarr/gate@X.Y.Z && sha256sum filarr-gate-X.Y.Z.tgz   # égal à library/… dans SHA256SUMS
gh release view vX.Y.Z --repo filarr-work/filarr-gate
docker buildx imagetools inspect ghcr.io/filarr-work/gate:X.Y.Z                    # linux/amd64 et linux/arm64
cosign verify ghcr.io/filarr-work/gate:X.Y.Z \
  --certificate-identity-regexp '^https://github.com/filarr-work/filarr-gate/\.github/workflows/release\.yml@refs/tags/v' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
git fetch origin release-journal && git show FETCH_HEAD:journal.jsonl | tail -1
```

- Les pages npm des deux paquets affichent « Provenance » et renvoient au passage du workflow ; dans un projet qui les
  installe, `npm audit signatures` vérifie les signatures et les attestations.
- La dernière ligne de `journal.jsonl` (branche `release-journal`) est l'entrée « published » : version, étiquette,
  commit, `codeHash` (`sha256:` + SHA-256 de `SHA256SUMS`) et `publishedAt`, l'heure à laquelle la chaîne a reçu
  l'étiquette, jamais la date que porte l'étiquette. La mise en service du service hébergé part de là (sept jours plus
  tard, sauf pour un correctif de sécurité accepté).

## Le service hébergé

La boîte hébergée tourne dans le script Worker `filarr-gate-host` (`packages/host`), dans le compte Cloudflare de l'API
de Filarr, isolé par script. Comment il est monté et ce qu'il garantit : [le service hébergé](explain/hosted.fr.md). Il
n'entre en service **que** par `.github/workflows/deploy-host.yml`, depuis une étiquette signée publiée depuis sept
jours au moins (sauf un correctif de sécurité accepté) : jamais depuis un poste, et le jeton de déploiement de
Cloudflare n'existe que dans ce workflow.

### Une fois : dans Cloudflare (le compte de l'API, zone `filarr.com`)

1. **Les personnes.** Membres du compte réduits au minimum, double authentification exigée pour tous. Aucun jeton
   d'API capable de déployer des Workers ne doit exister hors de la chaîne (vérifier **My Profile › API Tokens** de
   chaque membre).
2. **Le certificat.** **SSL/TLS › Edge Certificates › Order an advanced certificate**, nom `*.gate.filarr.com`
   (Advanced Certificate Manager, payant). Le certificat universel couvre `*.filarr.com`, pas `*.gate.filarr.com`.
3. **Le DNS.** Un enregistrement proxifié (nuage orange) nommé `*.gate`, par exemple `AAAA *.gate 100::` : la route du
   Worker répond devant lui, l'adresse elle-même n'est jamais atteinte.
4. **Les règles de zone pour `*.gate.filarr.com`** (expression `http.host wildcard "*.gate.filarr.com"`), pour qu'un
   logiciel qui appelle une boîte reçoive du JSON et jamais un défi, et qu'aucune requête ne soit gardée :
   - **Security › WAF › Custom rules** : une règle, action **Skip** (toutes les règles personnalisées restantes,
     toutes les règles gérées, et les règles de Super Bot Fight Mode si le plan les a), **Log matching requests
     décoché** ;
   - **Rules › Configuration Rules** : Browser Integrity Check éteint, Security Level « Essentially Off », détection
     JavaScript éteinte là où le plan expose le réglage, Email Obfuscation et Rocket Loader éteints ;
   - **Bot Fight Mode** (plan gratuit) ne s'écarte pas par nom d'hôte : il doit être éteint pour la zone (ou remplacé
     par Super Bot Fight Mode avec l'écart ci-dessus) ;
   - aucune tâche Logpush qui couvre ces noms, et aucune autre route de Worker sur `*.gate.filarr.com/*`.
   Le contrôle quotidien, en lecture seule, de ces règles et de la route relève de l'exploitation de Filarr (contrat
   § 10.3) ; il n'est pas dans ce dépôt.
5. **Le jeton de déploiement.** **My Profile › API Tokens › Create Token › Custom token** : *Account › Workers Scripts
   › Edit* sur le compte de l'API, *Zone › Workers Routes › Edit* sur `filarr.com`, rien d'autre. Le recopier une fois
   dans GitHub (section suivante), et nulle part ailleurs.
6. **Les clés du service**, depuis un clone propre de la branche par défaut, connecté à ce compte
   (`npx wrangler login`) :

   ```sh
   node scripts/host-keys.mjs
   npx wrangler secret put FILARR_API_URL --name filarr-gate-host     # valeur : https://api.filarr.com
   ```

   `host-keys.mjs` tire `HOST_ENC` (X25519) et `HOST_SIG` (Ed25519) en mémoire, passe chaque clé privée à
   `wrangler secret put … --name filarr-gate-host` par l'entrée standard (jamais sur la ligne de commande, sur le
   disque ni à l'écran), puis ajoute l'entrée publique à `docs/hosted-keys.json` et l'affiche. À lancer **une fois**.
   Il n'existe aucune copie des clés privées : perdues, elles se remplacent par une rotation. Si le script n'existe pas
   encore dans le compte, wrangler le crée vide en rangeant le premier secret ; son code n'arrive jamais que par la
   chaîne.
7. **Ensuite** : faire entrer `docs/hosted-keys.json` dans la branche par défaut par un changement relu (le service
   embarque cette liste : la première version à mettre en service doit être étiquetée **après** ce commit) ; donner la
   liste affichée à l'API de Filarr (variable `GATE_HOST_SIGN_KEYS`, avec `GATE_HOST_DOMAIN = gate.filarr.com` et
   `GATE_HOST_CONTROL_URL = https://ctl.gate.filarr.com`) et aux applis de Filarr (`GATE_HOST_KEYS`).

### Une fois : dans GitHub

- **Settings › Environments › New environment** `host-deploy` : branches de déploiement « Selected branches », règle
  `main` seulement (le workflow refuse aussi de partir d'une autre branche). Une relecture obligatoire peut être
  ajoutée, comme dernier contrôle avant chaque mise en service.
- Dans cet environnement : le secret `CLOUDFLARE_API_TOKEN` (le jeton de l'étape 5) et la variable
  `CLOUDFLARE_ACCOUNT_ID` (le compte de l'API, affiché sur sa page d'accueil). Nulle part ailleurs : aucun secret du
  dépôt, aucun autre environnement.
- `ADVISORY_READ_TOKEN` (étape 7 plus haut) est lu aussi par la mise en service, pour vérifier un avis de sécurité et
  lire sa gravité.

### À chaque mise en service

1. Une version publiée par `release.yml` qui contient le module du service : son `SHA256SUMS` liste
   `host/filarr-gate-host-X.Y.Z.js`. Les versions publiées avant que le module existe (0.2.0) ne se mettent pas en
   service.
2. Sept jours au moins après son entrée `published` dans `journal.jsonl` (branche `release-journal`).
3. **Actions › Deploy hosted service › Run workflow**, depuis `main`, avec l'étiquette `vX.Y.Z`.

Le workflow vérifie la signature de l'étiquette contre `release-signers` de la branche par défaut (deux fois), trouve
l'entrée `published` de l'étiquette, télécharge le `SHA256SUMS` et le module de la version publiée, vérifie le module
contre lui et le `codeHash` contre le journal, refuse avant sept jours, relance les essais sur le commit étiqueté et
reconstruit le module octet pour octet, met en service **ce** fichier (`wrangler deploy --no-bundle`) avec
`HOST_CODE_HASH`, `HOST_BUILD_REF` et `HOST_DEPLOYED_AT`, relit l'annonce servie à
`https://ctl.gate.filarr.com/.well-known/filarr-gate-host.json`, et écrit l'entrée `deployed` du journal. Dans les cinq
minutes, le service remet son annonce de version à l'API de Filarr, qui l'écrit au journal de chaque accès hébergé.
Relire le journal d'audit du compte Cloudflare après chaque mise en service.

**Un correctif de sécurité.** Étiqueter `vX.Y.Z-security` comme plus haut (étape « Un correctif de sécurité »), depuis
une branche de maintenance qui part du commit de la dernière version en service, et lancer le même workflow avec cette
étiquette dès que `release.yml` l'a publiée. La mise en service part sans délai seulement si le contrôle de
l'étiquette accepte le correctif (clé de rôle `security`, les deux lignes, avis existant), qu'une version est en
service et que le commit étiqueté en descend, et que la gravité de l'avis se lit ; le journal reçoit alors une entrée
`security` (publiée et mise en service au même moment, l'avis, sa gravité, « correctif de sécurité, délai de sept jours
levé ») et chaque accès hébergé en est averti. Une condition manque : c'est une version ordinaire, sept jours.

**Changer les clés du service.** `node scripts/host-keys.mjs --rotate --id h2 --not-before <date 60 jours plus tard au
moins>` ajoute `HOST_ENC_h2` et `HOST_SIG_h2` et la nouvelle entrée publique ; la nouvelle clé entre dans une version
des applis de Filarr 60 jours au moins avant son `notBefore`. Les anciennes clés privées restent : elles ouvrent les
jetons déjà scellés vers elles.
