# Installer la boîte noire sur votre compte Cloudflare

[Read in English](install-cloudflare.md)

**À la fin**, Filarr Gate tournera comme un Worker sur VOTRE compte Cloudflare : son API à
`https://filarr-gate.<votre-compte>.workers.dev` (ou à votre propre domaine), son interface de gestion sous `/admin/`,
le jeton en secret de votre Worker, que ni Filarr ni personne d'autre ne peut lire, et, si votre Filarr le propose,
Filarr qui la réveille quelques secondes après un changement.

**Palier :** tous les paliers de Filarr. L'offre Workers Free de Cloudflare suffit pour commencer (un Worker et un
Durable Object adossé à SQLite) ; la taille d'un corps de requête dépend de votre offre Cloudflare, ce qui borne le
plus gros fichier que la boîte noire peut recevoir.

## Ce qui change par rapport à la version Node

| | Node, Docker | Cloudflare |
|---|---|---|
| changements venus de Filarr | flux en direct, environ une seconde | pas de flux : le Durable Object dort entre deux **alarmes** et relève toutes les `FILARR_GATE_POLL_SECONDS` secondes (300 au moins) ; avec une **adresse de réveil**, Filarr le réveille en quelques secondes |
| synchros externes | tous les connecteurs | connecteurs HTTPS seulement (D1, Supabase, Airtable, Google Sheets, Notion, CSV ou JSON) ; **ni PostgreSQL ni MySQL** (pas de TCP) |
| réglages | environnement, `gate.toml`, interface | variables du Worker (verrouillées dans l'interface), et l'interface |
| écoute, TLS, cache | à votre choix | fixés : Cloudflare sert le HTTPS ; les blocs chiffrés vivent dans le stockage de l'objet |
| une boîte noire | un processus par jeton | un Worker par jeton (déployez un autre Worker, avec un autre `name`, pour un autre jeton) |

## Avant de commencer

- Un compte Cloudflare, et Node.js 20.19 ou plus récent.
- Le jeton `flr_live_…` ([ouvrir une base à une API](open-a-database.fr.md)).

## 1. Déployer

**Avec le bouton** (il copie ce dépôt dans votre compte GitHub et le déploie) :

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/filarr-work/filarr-gate)

Le formulaire demande les deux secrets de l'étape 2.

**Ou à la main**, depuis un clone :

```sh
git clone https://github.com/filarr-work/filarr-gate.git
cd filarr-gate
npm ci
npm run build                 # l'interface de gestion, servie par le Worker
npx wrangler login
npx wrangler deploy           # lit wrangler.jsonc à la racine du dépôt
```

`wrangler deploy` affiche l'adresse du Worker : `https://filarr-gate.<votre-compte>.workers.dev`.

## 2. Les deux secrets

```sh
npx wrangler secret put FILARR_GATE_TOKEN            # collez le jeton
npx wrangler secret put FILARR_GATE_ADMIN_PASSWORD   # le mot de passe de gestion, dix caractères ou plus
```

Ce sont des secrets de VOTRE compte : chiffrés par Cloudflare, jamais réaffichés, lisibles par votre Worker seulement.

## 3. Ouvrir l'interface de gestion

Allez sur `https://filarr-gate.<votre-compte>.workers.dev/admin/` et connectez-vous avec le mot de passe. La première
copie des bases se fait au premier réveil de l'objet : jusque-là, l'API répond `503` (`base_loading`).

**Protégez-la davantage** (recommandé) : mettez le chemin `/admin/*` derrière Cloudflare Access (Zero Trust › Access ›
Applications, une application auto-hébergée sur ce chemin, le fournisseur d'identité de votre entreprise). Qui entre
dans l'interface lit les données en clair.

## 4. Une clé d'application, un premier appel

Dans l'interface : **Clés des applications › Nouvelle clé**. Puis :

```sh
curl -s -H "Authorization: Bearer gk_…" "https://filarr-gate.<votre-compte>.workers.dev/v1/clients?limit=2"
```

La ligne de commande `filarr-gate` peut aussi piloter cette boîte noire, depuis votre ordinateur :

```sh
filarr-gate keys list --remote https://filarr-gate.<votre-compte>.workers.dev --admin-password '…'
```

## 5. Les changements en quelques secondes : l'adresse de réveil

Sans flux, la boîte noire relève Filarr toutes les cinq minutes. Pour qu'un changement fait dans Filarr lui arrive en
quelques secondes, donnez à l'accès cette **adresse de réveil** dans Filarr (**Paramètres › Accès API**, champ
« Adresse de réveil », dans les versions de Filarr qui le proposent) :

```text
https://filarr-gate.<votre-compte>.workers.dev/_filarr/notify
```

À chaque changement, Filarr y envoie un court message signé d'une clé tirée du jeton : aucun contenu, juste « relis ».
La boîte noire vérifie la signature et une fenêtre de cinq minutes, répond `202`, et relit par ses routes habituelles.
Un accès créé avant l'arrivée des réveils doit d'abord voir son jeton remplacé (Filarr le dit).

## Réglages

Les variables du Worker (`vars` dans `wrangler.jsonc`, ou le tableau de bord de Cloudflare) sont les variables
d'environnement de la [configuration](../reference/configuration.fr.md), et apparaissent verrouillées dans
l'interface. Par exemple :

```jsonc
// wrangler.jsonc
"vars": {
  "FILARR_GATE_WRITE": "true",
  "FILARR_GATE_CORS_ORIGINS": "https://shop.example.com",
  "FILARR_GATE_PUBLIC_URL": "https://gate.example.com"
}
```

`FILARR_GATE_PUBLIC_URL` est l'adresse que l'interface affiche et donne quand vous mettez le Worker derrière votre
propre domaine (Workers › votre Worker › Settings › Domains & Routes).

## L'essayer d'abord en local

`wrangler dev` fait tourner le Worker et son Durable Object sur votre machine ; rien ne part chez Cloudflare :

```sh
npm run mock-filarr          # dans un autre terminal : un Filarr en mémoire et son jeton
npx wrangler dev --local --var FILARR_GATE_API_URL:http://127.0.0.1:8790 \
  --var FILARR_GATE_TOKEN:flr_live_… --var FILARR_GATE_ADMIN_PASSWORD:'un long mot de passe'
```

La suite d'essais fait exactement cela (`test/cloudflare.test.ts`) : première copie, clés, lignes, écriture, un réveil
signé, l'état qui survit à un redémarrage.

## Ce qui reste sur votre compte

Le Durable Object garde, dans son propre stockage : l'état (empreintes des clés d'application, secrets des webhooks,
réglages), les blocs chiffrés tels que Filarr les garde, le journal local, et l'état chiffré des synchros. Les lignes
déchiffrées ne vivent qu'en mémoire, tant que l'objet est éveillé.

Workers Logs sont éteints dans le `wrangler.jsonc` du dépôt (`"observability": { "enabled": false }`). Pour les
allumer, mettez `"enabled": true` et redéployez. Cloudflare garde alors sur VOTRE compte, pour chaque requête, ses
métadonnées (méthode, l'URL avec sa requête, statut, durée) et les lignes de console de la boîte noire (chemins, codes,
durées ; jamais un jeton, une clé ni une ligne). La requête de l'URL porte ce que demandent les appelants : filtres
(`where`), recherches (`q`), tris. Ils sont gardés le temps de rétention de votre offre Cloudflare.

## Et ensuite

- [Appeler l'API](first-calls.fr.md), [recevoir des webhooks](webhooks.fr.md).
- [Synchroniser une base Cloudflare D1](sync-d1.fr.md) : la boîte noire sur votre compte, la clé de D1 dans votre
  Worker.

## Si ça ne marche pas

- `503 base_loading` qui dure : ouvrez `/admin/` (cela réveille l'objet) et regardez le **Tableau de bord** ; `/health`
  donne l'état de la liaison.
- Pas de réveil : vérifiez que l'adresse finit par `/_filarr/notify` ; l'écran **Journal** montre chaque réveil reçu,
  ou `réveil refusé` avec la raison (signature, fenêtre de temps).
- Plus de cas : [dépannage](../troubleshooting.fr.md).
