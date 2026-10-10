# Filarr Gate sur votre compte Cloudflare

[Read in English](cloudflare.md)

La même boîte noire que la version Node, dans un **Worker** et un **Durable Object** de VOTRE compte. Filarr ne tient
jamais le jeton : c'est un secret de votre Worker. Le pas à pas est dans le tutoriel
[installer sur votre compte Cloudflare](tutorials/install-cloudflare.fr.md).

## Déployer

Avec le bouton du README, ou à la main depuis un clone de ce dépôt :

```sh
npm ci
npm run build                                   # l'interface de gestion (packages/cli/dist/ui), servie par le Worker
npx wrangler deploy                             # wrangler.jsonc à la racine du dépôt
npx wrangler secret put FILARR_GATE_TOKEN       # le jeton montré une fois par Filarr
npx wrangler secret put FILARR_GATE_ADMIN_PASSWORD
```

L'API locale est l'adresse du Worker (`https://filarr-gate.<compte>.workers.dev`, ou votre propre domaine) ;
l'interface de gestion est sous `/admin/`. Les clés d'application s'y créent.

## Comment elle tourne

- Un Durable Object (adossé à SQLite, le seul genre permis par l'offre Free) garde l'état, le cache de blocs chiffrés,
  le journal et l'état chiffré des synchros, dans son propre stockage.
- Pas de boucle : l'objet dort entre deux **alarmes**. Toutes les `FILARR_GATE_POLL_SECONDS` (300 s au moins), il
  relève Filarr ; une synchro, un nouvel essai de webhook ou un passage planifié avance l'alarme.
- **Réveils poussés** : donnez `https://<votre worker>/_filarr/notify` comme adresse de réveil de l'accès dans Filarr.
  Filarr signe chaque réveil d'une clé tirée du jeton (`A_notify`) ; la boîte noire vérifie la signature et une fenêtre
  de 5 minutes, puis relit. Avec elle, un changement dans Filarr arrive à la boîte noire en quelques secondes au lieu de
  la relève suivante.
- Bases externes : les connecteurs HTTPS (D1, Supabase, Airtable, Google Sheets, Notion, CSV/JSON par URL).
  PostgreSQL et MySQL demandent TCP : prenez pour eux la version Node ou Docker. Leurs clés se donnent dans l'interface
  (rangées chiffrées) ou comme secrets du Worker `FILARR_GATE_EXTDB_<ID>`.

## Réglages

Les variables du Worker (`vars` dans `wrangler.jsonc`, ou le tableau de bord) sont les variables d'environnement de la
[configuration](reference/configuration.fr.md), et apparaissent verrouillées dans l'interface. Les réglages d'écoute,
de TLS et de cache ne s'appliquent pas ici. Deux de plus :

| variable | |
|---|---|
| `FILARR_GATE_PUBLIC_URL` | l'adresse à afficher et à donner, quand ce n'est pas celle où arrivent les requêtes |
| `FILARR_GATE_LOG_LEVEL` | `debug`, `info`, `warn`, `error` (journaux des Workers) |

## L'essayer en local

`wrangler dev` fait tourner le Worker et le Durable Object sur votre machine (rien ne part chez Cloudflare) :

```sh
npm run mock-filarr       # dans un autre terminal : un Filarr en mémoire sur 127.0.0.1:8790 et un jeton
npx wrangler dev --local --var FILARR_GATE_API_URL:http://127.0.0.1:8790 \
  --var FILARR_GATE_TOKEN:flr_live_… --var FILARR_GATE_ADMIN_PASSWORD:'un long mot de passe'
```

`test/cloudflare.test.ts` fait exactement cela dans la suite d'essais (première copie, clés, lignes, écriture, un
réveil poussé signé, l'état qui survit à un redémarrage).

## Les limites à connaître

- Un Worker, une boîte noire, un jeton. Plusieurs boîtes noires : plusieurs Workers (changez `name` dans
  `wrangler.jsonc`).
- La taille d'un corps de requête de Worker dépend de votre offre (100 Mo en Free et en Pro) : c'est aussi le plus gros
  fichier que prend la fente.
- Les nouveaux essais de webhooks et les passages qui tomberaient pendant que l'objet dort tournent à l'alarme
  suivante.
