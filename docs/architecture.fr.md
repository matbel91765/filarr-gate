# Architecture

[Read in English](architecture.md)

> Suit les contrats gelés des applis Filarr : `api-base-1` (révisions 2 et 3), `db-store-1` (3.9), `gate-fichiers-1`,
> `source-externe-1`, et le paquet de réglages de `gate-heberge-1`. Là où ce document et les contrats divergent, les
> contrats l'emportent.

## Les parties

| partie | tourne | rôle |
|---|---|---|
| Applis Filarr (bureau, web, mobile) | appareils de l'utilisateur | ouvrent une base à une API, créent le jeton de l'accès, rescellent les clés, publient le manifeste des vues |
| API de Filarr | serveurs de Filarr | garde les blocs chiffrés, les droits scellés et les compteurs ; authentifie les accès ; applique les limites des paliers |
| **Filarr Gate** | machine du client | réplique les bases ouvertes, les déchiffre, sert l'API locale, les webhooks, MCP, l'interface |

## Les bases, des magasins chiffrés

Une base Filarr vit dans un **magasin** chiffré : les lignes sont réparties dans des blocs d'environ 32 Kio, chacun
chiffré en AES-256-GCM sous une clé tirée de la clé de la base `K_db`. Les blocs sont immuables (un changement écrit
une nouvelle version) : une réplique ne télécharge que ce qui a changé, et garde le reste en cache pour toujours.

`K_db` est tirée à sens unique (HKDF-SHA256) de la clé racine du propriétaire, de l'identifiant du magasin, de
l'époque du coffre `e` et de la **génération** du magasin `g`. Détenir `K_db(e, g)` ouvre une base à une génération,
et rien d'autre : ni la clé racine, ni la génération suivante, ni une autre base. Chaque entrée de bloc de la tête
nomme le `(e, g)` sous lequel il est scellé (`g` absent vaut 0), et la réponse qui porte la tête dit quelle clé scelle
la tête (`hk`, `null` pour un rédacteur d'avant les générations).

## Le jeton de l'accès

```
flr_live_<accessId : 16 octets, base64url>_<secret : 32 octets, base64url>
```

Créé et montré une fois par l'appli Filarr ; jamais envoyé à Filarr. De `secret` (HKDF-SHA256, sel = `accessId`) :

- `A_auth` (`filarr/api/v1|auth`) : la preuve que la boîte noire présente à Filarr
  (`Authorization: Filarr-Access <accessId>.<A_auth>`). Filarr ne garde que `SHA-256(A_auth)`.
- `A_enc` (`filarr/api/v1|enc`) : la clé privée X25519 de l'accès. Filarr ne garde que sa clé publique.

La boîte noire tire les deux au démarrage et efface les octets du secret. L'appli qui crée l'accès signe la clé
publique de l'accès avec la clé d'identité de l'utilisateur, et vérifie cette signature avant chaque scellement : un
serveur ne peut pas substituer sa propre clé.

## Les droits et les manifestes

Pour chaque base ouverte, l'appli scelle `K_db(e, g)` pour la clé publique de l'accès (boîte scellée X25519,
AES-256-GCM), une entrée par `(e, g)` en usage. Le clair scellé nomme l'accès, le magasin, `e` et `g` ; **la boîte
noire refuse tout droit trouvé au mauvais endroit**, et note le refus dans son journal. Les droits se relisent par
`GET /api-access/self` ; les droits qu'on y lit sont les droits *effectifs* (`rw` se lit `r` quand le palier ou
l'interrupteur du serveur ne permettent pas l'écriture).

Les vues vivent dans la note Filarr, que la boîte noire ne peut pas lire. L'appli publie, par magasin, un instantané
scellé des vues (filtres, tris, colonnes, vues Requête et leur SQL) avec leurs slugs, et le republie quand l'une
change. La boîte noire lit les vues avec le lecteur même de Filarr (`parseDbData`) et les rejoue avec le moteur de
vues même de Filarr.

## À l'intérieur de la boîte noire

```
packages/core       le cœur portable de Filarr, recopié tel quel (chiffrement des magasins, codec, registres, zones, moteur de vues, moteur SQL),
                    plus les modules purs de la boîte noire : engine/gate (étiquette du créateur, réveils, fichiers, paquet de réglages) et
                    engine/extsrc (synchro externe : définitions, identité, conversions, mergeCell, planPass, scellés)
packages/gate       la bibliothèque : jeton, client HTTP de Filarr, ouvreurs de flux, cache de blocs, miroir de magasin, réplicateur, openGate
packages/server     la boîte noire sans moteur (Request/Response) : API locale, API de gestion, clés, webhooks, MCP,
                    fente à fichiers, exécutant et connecteurs de synchro, migration, doctor
packages/cli        Node : configuration, fichiers d'état (0600), adaptateur HTTP, ligne de commande, interface de gestion (Preact), Docker
packages/cloudflare un Worker et un Durable Object qui hébergent la même boîte noire
```

### La lecture

Pour chaque magasin : `GET /dbstore/:id/head` → ouvrir la tête sous `hk` (quand `hk` est nul, une tête d'avant les
générations : les clés de la génération 0, l'époque la plus récente d'abord) → pour chaque entrée de bloc, vérifier que
sa `K_db(e, g)` est détenue (sinon la base affiche « clé manquante pour (e, g) » et continue de servir son dernier état
complet) → prendre les blocs changés dans le cache local ou par `POST /dbstore/:id/slots:batchGet` (répété tant que
`more`) → vérifier chaque corps avec le MAC de la tête → déchiffrer → fusionner les registres « le dernier rédacteur
l'emporte » → matérialiser les lignes en mémoire. Un état partiel n'est jamais servi. Un serveur qui recule dans la
séquence est refusé.

Le cache local ne garde que des corps chiffrés, adressés par leur contenu (SHA-256), avec un index `p|ver` par
magasin, revérifiés au regard de la tête avant usage. `FILARR_GATE_CACHE=memory` ne garde rien sur le disque.

### Rester à jour

`GET /api-access/self/stream` (WebSocket) : `commit` déclenche une relecture de ce magasin, `grant` et `manifest` une
relecture de `self`, `quota` une alerte (journal, interface, webhooks `gate.quota`), `revoked` l'effacement. La boîte
noire envoie un `{"t":"ping"}` applicatif toutes les 30 s (le relais coupe la connexion à tout autre message) et se
reconnecte avec un délai croissant et aléatoire. Codes de fermeture : 4301 révoqué ou jeton remplacé (effacement), 4302
en pause, 4303 accès changé (relire `self`), 4304 expiré (effacement), 4305 quota mensuel de synchro épuisé (relève
toutes les 900 s jusqu'au mois suivant), 4306 trop de flux (espacer les tentatives).

Sans le flux (Free : `access.stream` vaut false), la boîte noire relève `GET /dbstore/:id/changes?since=` par magasin,
jamais plus vite que le `pollIntervalS` du palier ni que `FILARR_GATE_POLL_SECONDS`, et ne lit la tête
que quand un magasin a bougé. Sur `410 since_too_old`, elle se rabat sur la tête.

### Les limites

Chaque `429` est respecté. `api_rate` suspend tout échange avec Filarr jusqu'à `Retry-After`. `api_poll_interval`,
`api_quota_sync` (sur une tête ou des changements) et `api_quota_bytes` ne retiennent que le magasin concerné.
`api_quota_writes` est renvoyé à l'application qui a tenté d'écrire, avec `Retry-After`. Les lectures locales continuent
tout du long. Les en-têtes `X-Filarr-Quota` et `RateLimit-*` de chaque réponse alimentent l'écran « Consommation et
limites » ; la table des paliers vient de `GET /public/api-limits`.

### L'écriture (§ 7, éteinte d'office)

Un `POST`/`PATCH`/`DELETE` local se traduit par des opérations de registre horodatées par l'horloge logique hybride de
la boîte noire (son identifiant de site est tiré une fois par installation). Les blocs touchés sont réécrits (découpés
au-delà de 32 Kio), scellés sous `K_db(e en cours, g en cours)`, la tête est reconstruite (racine de Merkle, index des
zones) et scellée sous la même clé avec `seq + 1` en AAD, et `POST /dbstore/:id/commit` porte `baseSeq`, le `g` de
chaque bloc et `hk`. Sur `409 seq_conflict`, `stale_generation`, `slot_version` ou `bad_cover`, la boîte noire relit la
tête, rescelle et rejoue (les registres fusionnent comme une union). Sans la clé de la génération en cours, l'écriture
est refusée ; elle n'est jamais scellée sous une clé plus ancienne. Les restrictions à des colonnes ou à des vues sont
appliquées par la boîte noire (portées des clés d'application), pas par le chiffrement.

### Les relations vers des bases non ouvertes (§ 8)

La boîte noire ne lit jamais une base qu'on ne lui a pas donnée. Une cellule de relation rend les identifiants de
lignes bruts ; un agrégat sur une telle base rend `null` et le champ est listé dans `unresolved`. Les relations entre
bases ouvertes se résolvent par l'identifiant du bloc propriétaire de chaque magasin (`head.dbId`). En SQL, une base
non ouverte apparaît comme une table qui ne contient que `id`, comme dans la vue Requête de Filarr.

## La révision 3

### La clé du créateur

`GET /api-access/self` rend `creator: { userId, signingPublicKey, tag }` et `access.bindSig`. La boîte noire recalcule
`tag = HMAC(A_mac, "filarr/api/v1|creator|" + accessId + "|" + signingPublicKey)` avec `A_mac` tirée du jeton, et
vérifie `bind_sig` (la signature, par le créateur, de la clé publique de l'accès). Alors seulement la clé est
**authentifiée** : les boîtes de dépôt (`boxSig`), les définitions de synchro et une cible de migration ne sont
acceptées que signées par elle. Un serveur ne peut pas forger l'étiquette, ni substituer sa propre clé.

### Les réveils poussés

Quand le créateur donne une adresse, Filarr envoie `{ a, t, storeId?, seq?, state?, at }` en POST à `/_filarr/notify`,
signé `Filarr-Notify: t=<s>,v1=HMAC-SHA256(A_notify, t + "." + corps)`. La boîte noire vérifie la signature sur le corps
brut et une fenêtre de 300 secondes, répond 202, puis relit par ses routes habituelles : un réveil ne porte aucun
contenu. Le code de fermeture 4308 (boîte hébergée en sommeil) n'est pas une erreur.

### La fente à fichiers

`POST /v1/files` → le filtre (liste d'extensions, signatures d'exécutables MZ/ELF/Mach-O/`#!`, taille) refuse avant que
rien ne parte → une `K_file` neuve, des morceaux de 16 Mio (`IV ‖ AES-GCM`), le manifeste chiffré sous `K_file`, et
`K_file` scellée pour la boîte de dépôt (`filarr.filerequest.seal.v1`) → `self/files/init`, `chunk`, `finalize`.
L'appli l'ouvre et le range ; la boîte noire n'apprend que `filed` ou `rejected` (et les webhooks `file.filed` partent).

### Les bases externes

L'exécutant des synchros lit les définitions dans `schema.extra.extSource` des magasins ouverts qui nomment cet accès,
vérifie leur signature, et fait un passage sous bail : décisions de la boîte aux lettres, lecture de la source,
`planPass` (pur, le même code que font tourner les applis), écritures conditionnelles dans la source, une validation
dans Filarr, puis la référence chiffrée (`K_shadow`) et l'état et la file publiés (`K_xs`, lisibles par les membres de
la base). Voyez [external-databases.fr.md](external-databases.fr.md).

### La migration

Le paquet de réglages (`gate-settings-1` : empreintes des clés d'application, webhooks et secrets, requêtes
enregistrées, références des synchros, filtre de fichiers, CORS, écriture) est scellé pour la clé publique de la boîte
noire suivante après vérification de son `bind_sig`, en ligne (`self/export`, puis l'identité en attente lit
`self/import`) ou par fichier (`filarr-gate export` / `init --import`). Il ne porte jamais le mot de passe de gestion ni
aucune clé de base externe.

### Où elle tourne

La boîte noire repose sur `Request`/`Response` et de petites interfaces de stockage (état, journal, cache de
blocs, objets). Node ajoute les fichiers, les ports et le flux `ws` ; la variante Cloudflare ajoute un Durable Object,
des alarmes au lieu de minuteries, et aucun flux (relève plus réveils). La bibliothèque n'emploie que le réplicateur.

## La révocation

1. Filarr refuse aussitôt le jeton et l'annonce sur le flux (`revoked`, fermeture 4301).
2. La boîte noire s'arrête, efface de la mémoire les clés tirées du jeton, les clés des bases et les lignes, et supprime
   son cache de blocs.
3. L'appli fait monter la génération de chaque magasin que l'accès pouvait lire et rescelle les nouvelles clés pour les
   accès qui restent. Tout ce qui s'écrit ensuite est illisible avec les anciennes clés, même si des blocs fuient.

## Les limites par palier

Filarr ne mesure que le trafic qui passe par Filarr : requêtes de synchro, octets téléchargés (blocs et têtes),
validations acceptées (une validation peut porter plusieurs lignes ; Filarr ne voit pas les lignes). Les lectures
locales ne sont jamais mesurées. Quand une limite est atteinte, la boîte noire continue de servir sa dernière copie ;
les écritures et les téléchargements attendent la fenêtre suivante.

## Ce que voit chacun

- **Filarr** : l'identifiant de l'accès, sa clé publique, l'empreinte de la preuve, les droits scellés, le manifeste
  scellé, les compteurs, l'adresse IP du client et la version de la boîte noire. Jamais le jeton, `A_enc`, `K_db` ni
  une ligne.
- **La boîte noire** : toutes les lignes et toutes les colonnes des bases ouvertes. Les vues sont un confort, pas une
  frontière de sécurité.
- **Vos logiciels** : ce que leur clé d'application permet, rien de Filarr.
- **Les récepteurs de webhooks** : les lignes (et les champs) que leur webhook sélectionne, signées.
