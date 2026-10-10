# Connecteurs de bases externes

[Read in English](sync-connectors.md)

Une synchro est **définie dans Filarr** (« ··· » sur une base › « Alimenter depuis une base externe… », qui arrive avec
une prochaine version de l'appli) et **exécutée par l'exécutant qu'elle nomme**. Cette page liste ce dont la boîte
noire a besoin pour chaque connecteur quand c'est elle l'exécutant. Tutoriels : [D1](../tutorials/sync-d1.fr.md),
[PostgreSQL](../tutorials/sync-postgres.fr.md). La règle de la synchro dans les deux sens :
[explain/two-way-sync.fr.md](../explain/two-way-sync.fr.md).

**Palier :** une synchro planifiée et exécutée par une boîte noire demande Solo ou plus.

## Ce que la boîte noire vérifie avant un passage

1. La définition nomme l'accès de cette boîte noire (`runner.accessId`) et est valide (connecteur, hôte qui correspond
   à la connexion, requêtes `SELECT` seulement, colonnes clés associées, une politique de conflit pour les colonnes
   dans les deux sens…) ; sinon `extdb_def_invalid` avec les codes, ou `extdb_policy_missing`.
2. Elle est **signée par le créateur de l'accès**, dont la boîte noire a authentifié la clé par l'étiquette du
   créateur ; sinon `extdb_unsigned`.
3. Le palier permet les synchros planifiées (`extdb_tier`), le connecteur peut tourner ici (pas de TCP sur Cloudflare),
   la **clé** est présente (`extdb_key_missing`), la synchro n'est pas en pause sur cette boîte noire.
4. La boîte noire tient le **bail** de la définition chez Filarr : deux processus lancés avec le même jeton ne font
   jamais de passage en même temps (`extdb_lease_held`).

## Donner la clé

La clé ne passe jamais par Filarr. Par ordre de priorité :

1. la variable `FILARR_GATE_EXTDB_<ID>` : `<ID>` est formé des 8 premiers caractères après `xs_` de l'identifiant de la
   définition, en majuscules (`xs_DemoClientsBoutique002` → `FILARR_GATE_EXTDB_DEMOCLIE`) ;
   `filarr-gate sources list` affiche le nom exact ;
2. `gate.toml` :

   ```toml
   [extdb."xs_DemoClientsBoutique002"]
   secret = "…"
   ```

3. l'écran **Sources** de l'interface de gestion, ou `filarr-gate sources key <id> --stdin` (ou `--secret`, `--clear`) :
   enregistrée dans l'état, chiffrée sous une clé tirée du jeton. Après un changement de jeton, donnez-la de nouveau.

La boîte noire ne pose une clé que sur les requêtes vers les hôtes propres au connecteur.

## Les connecteurs

| connecteur | clé à donner à la boîte noire | `conn` dans la définition | où il tourne | écrit « seulement si inchangé » |
|---|---|---|---|---|
| Cloudflare D1 | un jeton d'API avec Account › D1 › Read (miroir) ou Edit (publication, dans les deux sens) | `account`, `database` | partout | oui : `WHERE key = ? AND col IS ?` |
| PostgreSQL | le mot de passe du rôle | `host`, `port` (5432), `db`, `user`, `schema` (`public`), `tls` | Node, Docker | oui : `IS NOT DISTINCT FROM`, une transaction par passage |
| MySQL, MariaDB | le mot de passe de l'utilisateur | `host`, `port` (3306), `db`, `user`, `tls` | Node, Docker | oui : `<=>`, une transaction par passage |
| Supabase | une clé du projet (la clé de service contourne la sécurité par ligne ; une clé plus restreinte est préférable) | `url`, `schema` | partout | oui : un filtre sur l'ancienne valeur, `Prefer: return=representation` |
| Airtable | un jeton d'accès personnel avec le droit de lecture (et d'écriture) sur cette base | `base` (`app…`), `table`, `view` | partout | **non** : relecture juste avant d'écrire |
| Google Sheets | le JSON d'un compte de service ; partagez la feuille avec son adresse | `spreadsheet`, `tab`, `headerRow` | partout | **non** : relecture juste avant d'écrire |
| Notion | un jeton d'intégration ; invitez l'intégration sur la base | `database` | partout | **non** : relecture juste avant d'écrire |
| CSV ou JSON par URL | un jeton porteur facultatif | `url` (https), `format` | partout | lecture seule (`once`, `mirror`) |

Le détail par connecteur :

- **D1** : `POST https://api.cloudflare.com/client/v4/accounts/<account>/d1/database/<database>/query`, requêtes
  paramétrées, pages de 1000 triées par la clé, repère en `>=` (des horodatages égaux ne se perdent jamais), insertion
  avec `RETURNING` ; requête par requête (D1 n'a pas de transaction par HTTP).
- **PostgreSQL** : le pilote `pg`, chargé à la demande. `tls` : `verify-full` (par défaut, certificat vérifié par
  rapport au nom d'hôte), `require` (chiffré, certificat non vérifié), `off-local` (sans TLS, réseau local seulement :
  plages privées, `.lan`, `.local`, `.internal`, `.home.arpa`). Pages par clé (keyset) quand la clé tient en une
  colonne. Les dates restent en `AAAA-MM-JJ` ; un `numeric` se lit comme un nombre. Une source `query` tourne dans une
  transaction en lecture seule.
- **MySQL** : le pilote `mysql2`, chargé à la demande, les mêmes règles de TLS ; `LAST_INSERT_ID()` pour la nouvelle
  clé.
- **Supabase** : le PostgREST du projet (`/rest/v1/<table>`), la clé en `apikey` et en `Authorization: Bearer`,
  envoyée à l'hôte du projet seulement.
- **Airtable** : `api.airtable.com/v0`, pages de 100, 10 enregistrements par écriture, au plus 5 requêtes par seconde
  et par base. La colonne `id` est l'identifiant de l'enregistrement (`rec…`). Le repère est un champ de date comme
  « Last modified time ». Un champ d'enregistrements liés ne peut pas être associé (`unsupported_column` ; rencontré à
  la lecture, il arrête le passage avant toute écriture).
- **Google Sheets** : `sheets.googleapis.com` ; la boîte noire signe elle-même le JWT du compte de service et n'envoie
  que l'assertion à `oauth2.googleapis.com`, jamais la clé privée. Tout l'onglet est relu à chaque passage (pas de
  repère) ; la clé de ligne est tirée au hasard par l'exécutant (une colonne de texte de 64 caractères au moins) et une
  ligne se retrouve par sa clé quand elle est écrite ou effacée, jamais par un numéro de ligne retenu d'avant.
- **Notion** : `api.notion.com`, `Notion-Version: 2022-06-28` fixée par le connecteur, pages de 100, au plus 3 requêtes
  par seconde. La colonne `id` est l'identifiant de la page ; le repère, `last_edited_time` ; les titres et les textes
  enrichis en texte simple, les sélections par leur nom, les dates par leur début. Supprimer veut dire mettre à la
  corbeille. Une propriété de relation ne peut pas être associée (`unsupported_column`).
- **CSV ou JSON** : `GET` en https ; CSV selon la RFC 4180 (séparateur et ligne d'en-tête réglables), JSON depuis un
  chemin simple (`$.items`, `$.data.rows`).

**Sans « seulement si inchangé »** (Airtable, Google Sheets, Notion), il reste une fenêtre de moins d'une seconde entre
la relecture et l'écriture : un changement fait dans la source à cet instant peut être écrasé (la valeur écrasée est
gardée au journal).

## Les limites d'un passage

- 100 000 lignes par définition (`extdb_too_large`) ; la relecture complète d'une grande table sans repère est lente :
  ajoutez un repère.
- Au plus deux passages en même temps par boîte noire ; les débits des services ci-dessus sont respectés ; après un
  `429` de la source, la boîte noire attend son `Retry-After`.
- Une validation dans Filarr par passage qui change quelque chose (elle compte pour une écriture dans les limites du
  palier).
- Après un échec : 1, 2, 4… minutes, jusqu'à une fois par heure.

## Les fréquences

`15m`, `1h` (± 10 % de variation), `1d` à une heure donnée, dans un fuseau horaire, `manual` ; pour la publication et
les deux sens, aussi 10 secondes après un changement dans Filarr (au plus une fois toutes les 30 secondes). Un membre
peut demander un passage depuis Filarr ; **Lancer maintenant** sur l'écran **Sources**, ou `filarr-gate sources run
<id>`.

## Les codes d'état

[errors.fr.md, états d'une synchro externe](errors.fr.md#états-dune-synchro-externe).
