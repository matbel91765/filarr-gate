# Synchroniser une base Cloudflare D1, dans tous les sens

[Read in English](sync-d1.md)

> **Bientôt, côté Filarr.** La boîte noire exécute ces synchros dès aujourd'hui, et chaque étape de ce tutoriel qui se
> passe dans la boîte noire ou dans D1 est exécutée par la suite d'essais (`test/examples-sync.test.ts`) contre un D1
> simulé sur SQLite, le moteur même de D1. Les écrans de Filarr qui créent une synchro (« ··· » sur une base ›
> « Alimenter depuis une base externe… ») arrivent avec une prochaine version de l'appli, et la fonction ouvre compte
> par compte. Les étapes côté Filarr ci-dessous suivent le contrat gelé `source-externe-1` ; elles seront vérifiées à
> l'écran quand l'appli les livrera.

**À la fin**, vous aurez une base Filarr alimentée par une table D1 (miroir entrant), une base Filarr publiée vers D1
(publication vers la source), et une base synchronisée **dans les deux sens** avec une politique de conflit choisie
colonne par colonne, « me demander » compris, dont les conflits attendent votre décision. La clé de D1 reste dans votre
boîte noire : Filarr ne la voit jamais, ni les lignes.

**Palier :** une synchro planifiée et exécutée par une boîte noire demande Solo ou plus. (Un import ponctuel depuis
l'appli de bureau est offert à tous les paliers.)

## Comment ça marche, en cinq mots

- **La définition** vit dans la base Filarr, chiffrée comme ses lignes : quel connecteur, quelle table, quelles
  colonnes vont où, quel **sens**, que faire en cas de conflit, qui l'exécute. Elle ne contient jamais de secret.
  L'appli Filarr la **signe** avec votre clé d'identité : la boîte noire refuse une définition que quelqu'un d'autre a
  changée.
- **L'exécutant** est cette boîte noire : elle lit les définitions qui nomment son accès, prend un bail (un seul
  exécutant à la fois), lit D1 et sa propre copie de Filarr, décide, écrit dans D1 et dans Filarr.
- **La clé de ligne** (`id`) associe une ligne de D1 à une ligne de Filarr. Une ligne créée depuis D1 reçoit un
  identifiant Filarr calculé à partir de la source et de la clé (`ext-…`) : importer deux fois la même table ne fait
  jamais de doublon.
- **Le repère** (`maj_le`) permet à chaque passage de ne lire que les lignes changées depuis le précédent ; une relecture
  complète toutes les 24 heures (ou tous les 96 passages) rattrape le reste.
- **La référence** retient, pour chaque cellule, la dernière valeur sur laquelle les deux côtés étaient d'accord (une
  empreinte, chiffrée sur le disque de la boîte noire) : c'est ainsi que la boîte noire sait quel côté a changé.

## 1. Préparer la table D1

[examples/sync-d1/schema.sql](../../examples/sync-d1/schema.sql). Ses commentaires le disent en anglais : `id` est la
clé de ligne sur laquelle la synchro associe les lignes, stable et jamais réutilisée ; `maj_le` est le repère, que la
synchro lit pour ne prendre que les lignes changées depuis son dernier passage, et que « la plus récente l'emporte »
compare à l'horloge de Filarr ; ISO 8601, UTC, à la milliseconde.

<!-- snippet: examples/sync-d1/schema.sql#table -->
```sql
-- `id` is the row key the sync matches rows on: stable, never reused.
-- `maj_le` is the change marker: the sync reads only the rows changed since its last pass,
-- and "the most recent wins" compares it with Filarr's clock. ISO 8601, UTC, with milliseconds.
CREATE TABLE IF NOT EXISTS clients (
  id     INTEGER PRIMARY KEY,
  nom    TEXT NOT NULL,
  ville  TEXT,
  statut TEXT NOT NULL DEFAULT 'Prospect',
  note   TEXT,
  maj_le TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
```

Un déclencheur tient le repère à jour, qui que ce soit qui écrive (votre application, un script, ou la synchro ; un
`UPDATE` qui fixe lui-même `maj_le` garde sa valeur, c'est la clause `WHEN`) :

<!-- snippet: examples/sync-d1/schema.sql#trigger -->
```sql
-- Keep `maj_le` right whoever writes: your application, a script, or the sync itself.
-- (An UPDATE that sets maj_le itself keeps its value: the WHEN clause.)
CREATE TRIGGER IF NOT EXISTS clients_maj_le
AFTER UPDATE OF nom, ville, statut, note ON clients
FOR EACH ROW WHEN NEW.maj_le = OLD.maj_le
BEGIN
  UPDATE clients SET maj_le = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id;
END;
```

La lecture incrémentale est `WHERE maj_le >= ? ORDER BY id` : un index sur le repère la garde rapide.

<!-- snippet: examples/sync-d1/schema.sql#index -->
```sql
-- The incremental read is `WHERE maj_le >= ? ORDER BY id`: an index on the marker keeps it fast.
CREATE INDEX IF NOT EXISTS clients_maj_le_idx ON clients (maj_le);
```

```sh
npx wrangler d1 execute boutique --remote --file examples/sync-d1/schema.sql
```

Une clé de ligne doit être stable et jamais réutilisée ; un repère doit changer à chaque changement de la ligne. Sans
repère, la synchro marche quand même, mais relit toute la table à chaque passage.

## 2. Un jeton Cloudflare limité

Dans le tableau de bord de Cloudflare, **My Profile › API Tokens › Create Token › Custom token** :

- **Permissions** : Account › **D1** › **Read** pour un miroir entrant ; **Edit** pour publier ou synchroniser dans les
  deux sens (la documentation de l'API de Cloudflare les appelle « D1 Read » et « D1 Write »). Rien d'autre.
- **Account resources** : votre compte seulement.

La boîte noire appelle le point d'accès de requête de D1 (`POST /accounts/<compte>/d1/database/<base>/query`) avec du
SQL paramétré, et n'envoie le jeton qu'à `api.cloudflare.com`. Notez l'identifiant du compte et celui de la base
(Workers & Pages › D1 › votre base).

## 3. Dans Filarr : la définition (bientôt)

Sur la base Filarr qui recevra les lignes, « ··· » › « Alimenter depuis une base externe… » :

1. **Connecteur et clé** : Cloudflare D1, l'identifiant de votre compte et celui de la base. Sur le bureau ou le web,
   la clé irait dans votre trousseau ; pour une synchro exécutée par une boîte noire, vous la donnez à la boîte noire
   (étape suivante) et Filarr ne la voit jamais.
2. **Colonnes** : la table, chaque colonne associée à une colonne de Filarr, la **clé de ligne** (`id`), le **repère**
   (`maj_le`). Les colonnes que vous n'associez pas ne sont jamais lues. Les colonnes de Filarr que vous n'associez pas
   restent **à vous** : jamais écrasées, jamais envoyées.
3. **Sens, exécutant, fréquence** : le sens (plus bas), **cette boîte noire** comme exécutant (le nom de son accès),
   toutes les 15 minutes, toutes les heures, chaque jour à une heure, ou à la demande ; que faire des lignes qui
   disparaissent ; et, dans les deux sens, les **politiques de conflit** : Filarr n'en coche aucune et ne vous laisse
   pas continuer tant que vous n'avez pas choisi.

Filarr écrit la définition dans la base et la signe. Ce que lit la boîte noire, pour l'exemple dans les deux sens
([examples/sync-d1/definition.both.json](../../examples/sync-d1/definition.both.json) ; les identifiants sont ceux de
l'exemple) :

<!-- snippet: examples/sync-d1/definition.both.json -->
```json
{
  "v": 1,
  "id": "xs_DemoClientsBoutique002",
  "rev": 1,
  "name": "Clients de la boutique",
  "connector": "d1",
  "conn": { "account": "0123456789abcdef0123456789abcdef", "database": "7c1e2b0a-0000-4000-8000-000000000002" },
  "host": "api.cloudflare.com",
  "from": { "table": "clients" },
  "key": { "cols": ["id"], "gen": "source" },
  "marker": { "col": "maj_le", "kind": "iso" },
  "mode": "both",
  "map": [
    { "col": "id", "prop": "p_id", "dir": "in", "type": "number" },
    { "col": "nom", "prop": "p_nom", "dir": "both", "type": "text" },
    { "col": "ville", "prop": "p_ville", "dir": "both", "type": "text", "conflict": "source" },
    { "col": "statut", "prop": "p_statut", "dir": "both", "type": "select", "conflict": "ask" },
    { "col": "note", "prop": "p_note", "dir": "both", "type": "text", "conflict": "filarr" }
  ],
  "conflict": "latest",
  "rowConflict": "keep",
  "onGone": "mark",
  "onFilarrDelete": "delete",
  "guard": { "pct": 20, "min": 10 },
  "runner": { "kind": "gate", "accessId": "<the access id>", "name": "ERP Atelier" },
  "schedule": { "every": "15m", "tz": "Europe/Paris" },
  "signer": "<the user id of the access creator>",
  "sig": "<signature by the creator's identity key>"
}
```

## 4. Donner la clé à la boîte noire

```sh
filarr-gate sources list
```

```text
xs_DemoClientsBoutique002  Clients de la boutique
    d1 · api.cloudflare.com · both · 15m · base clients-de-la-boutique
    bloquée : extdb_key_missing (clé manquante pour api.cloudflare.com)
    clé : manquante (FILARR_GATE_EXTDB_DEMOCLIE)
```

Donnez la clé par l'entrée standard, pour qu'elle reste hors de l'historique de votre shell :

```sh
printf '%s' "$CLOUDFLARE_D1_TOKEN" | filarr-gate sources key xs_DemoClientsBoutique002 --stdin
```

```text
Clé enregistrée (chiffrée sur cette machine).
```

ou sur l'écran **Sources** de l'interface de gestion, ou dans la variable `FILARR_GATE_EXTDB_DEMOCLIE` (le nom que la
liste affiche), ou dans `gate.toml` (`[extdb."xs_DemoClientsBoutique002"] secret = "…"`). La boîte noire range une clé
donnée par la commande ou l'interface chiffrée sous une clé tirée de son jeton ; elle ne l'envoie jamais à Filarr, ne
l'écrit jamais au journal, et un paquet de réglages ne la porte jamais.

## 5. Le premier passage

```sh
filarr-gate sources run xs_DemoClientsBoutique002
```

```text
Passage : ok
```

Les lignes de D1 sont dans Filarr, avec des identifiants `ext-…`. La boîte noire publie l'état de la synchro, chiffré
pour que les membres de la base puissent le lire et Filarr non : quand elle a tourné, ce qu'elle a changé, le prochain
passage, les conflits en attente. L'écran **Sources** montre la même chose.

## Miroir entrant : D1 fait foi

`mode: "mirror"`, chaque colonne associée en `in` ([definition.mirror.json](../../examples/sync-d1/definition.mirror.json)).

- Chaque passage apporte les changements de D1 dans Filarr.
- Les colonnes associées sont **verrouillées** dans Filarr : un cadenas, pas de modification, « vient de D1 ». L'API
  locale de la boîte noire refuse de les écrire (`409 field_managed`) et refuse de créer ou de supprimer des lignes
  (`409 rows_managed`).
- Une colonne de Filarr que vous n'avez pas associée reste à vous : modifiable dans Filarr et par l'API, jamais envoyée
  à D1.
- Une valeur changée dans Filarr par une ancienne appli qui ignore le verrou est remplacée au passage suivant, et le
  journal garde l'ancienne valeur.

## Publication vers la source : Filarr fait foi

`mode: "publish"`, les colonnes associées en `out` sauf la clé ([definition.publish.json](../../examples/sync-d1/definition.publish.json)).

- Les lignes de Filarr sont insérées dans D1 ; l'identifiant que D1 leur donne (`RETURNING`) revient dans la colonne
  clé de Filarr.
- Un changement dans Filarr arrive à D1 au passage suivant, ou 10 secondes après le changement quand la fréquence dit
  « à chaque changement ».
- Une valeur changée dans D1 hors de Filarr est remplacée par celle de Filarr, et le journal garde celle de D1.
- Le jeton a besoin de D1 Edit.

## Dans les deux sens

`mode: "both"`. Pour chaque cellule, à chaque passage, la boîte noire compare les deux côtés à la référence :

| D1 a changé ? | Filarr a changé ? | ce qui se passe |
|---|---|---|
| non | non | rien |
| oui | non | Filarr prend la valeur de D1 |
| non | oui | D1 prend la valeur de Filarr |
| oui, vers la même valeur | oui | rien ; la référence avance |
| oui | oui, vers des valeurs différentes | **un conflit** : la politique de la colonne décide |

« Filarr a changé » veut dire que l'horloge propre à la cellule a changé dans Filarr, pas que « la ligne a été
touchée » : un appareil qui revient en ligne avec une vieille modification n'est jamais perdu en silence.

### Les quatre politiques

Vous en choisissez une par colonne, ou une pour toute la définition (`conflict`), que suivent les colonnes qui n'ont
pas la leur. Aucune n'est choisie pour vous. L'exemple emploie les quatre sur une même ligne ; voici ce que voit la
suite d'essais quand Filarr change d'abord Acme, puis que D1 change les quatre mêmes cellules :

| colonne | politique | résultat |
|---|---|---|
| `nom` | **La plus récente l'emporte** (`latest`) | la valeur de D1 : son repère est plus récent que l'horloge de Filarr |
| `ville` | **La source l'emporte** (`source`) | la valeur de D1 |
| `note` | **Filarr l'emporte** (`filarr`) | la valeur de Filarr, écrite dans D1 |
| `statut` | **Me demander** (`ask`) | rien d'écrit d'un côté ni de l'autre : la cellule attend dans la file |

Chaque valeur qui perd va au journal de la synchro, avec « Rétablir ». `latest` demande un repère qui soit une date, et
date la LIGNE, pas la cellule : un changement plus récent d'une autre colonne dans D1 fait gagner D1 sur celle-ci
aussi. Il compare aussi deux horloges de deux machines.

### « Me demander » : la file

Un conflit sur une colonne « me demander » entre dans une **file** : Filarr garde sa valeur, D1 garde la sienne, la
référence ne bouge pas, et le reste de la ligne et de la table continue de se synchroniser. L'état dit « 1 conflit à
trancher », et la cellule porte une pastille « conflit » dans Filarr.

Dans Filarr, la file liste chaque conflit (ligne, colonne, valeur de D1 et sa date, valeur de Filarr) avec **garder la
valeur de Filarr** ou **prendre celle de la source**, un par un ou tous d'un coup. La décision part, chiffrée, vers la
boîte aux lettres de l'exécutant et déclenche un passage : la boîte noire l'applique, la valeur perdante va au journal
avec « Rétablir », et l'entrée quitte la file. Dans la suite d'essais, la décision « prendre celle de la source » fait
passer le `statut` de Filarr à la valeur de D1 en moins d'une seconde.

Ce que la file garantit :

- **Une décision vaut pour les valeurs sur lesquelles elle a été prise.** Si un côté a changé depuis, la décision est
  périmée : le conflit est réévalué, et une nouvelle entrée remplace l'ancienne.
- **Deux personnes tranchent le même conflit** : la première décision reçue l'emporte ; la seconde est mise de côté, et
  le journal dit qui a tranché.
- **Une file pleine** (500 entrées) : les nouveaux conflits attendent une place, leurs cellules ne se synchronisent pas
  en attendant, et l'état dit combien attendent.
- **Passer une colonne de « me demander » à une politique automatique** alors qu'elle a des conflits en attente vous
  demande, explicitement, s'il faut les trancher avec la nouvelle règle ou les garder à trancher à la main.

### « Rétablir »

Sur une entrée du journal (un conflit, une valeur remplacée, une décision), **Rétablir** réécrit la valeur perdue dans
Filarr comme une modification ordinaire. Au passage suivant, Filarr seul a changé : la valeur part vers D1 si la
colonne y va. Dans la suite d'essais, rétablir la `ville` qui avait perdu face à D1 la remet dans D1 au `sources run`
suivant.

### Les lignes supprimées d'un côté, modifiées de l'autre

`rowConflict`, choisi lui aussi sans réglage d'office : **la suppression l'emporte** (`delete`), **la ligne est
gardée** (`keep` : restaurée dans Filarr avec les valeurs de D1, ou recréée dans D1 avec celles de Filarr), ou **me
demander** (`ask`) : la ligne attend dans la file, avec « Supprimer des deux côtés » ou « Garder la ligne ».

## Les lignes qui disparaissent, et le garde-fou

- Une ligne disparue de D1 est, selon `onGone`, **marquée** dans Filarr (« Disparue de D1 », barrée, vos colonnes
  gardées, plus synchronisée), supprimée, ou laissée telle quelle.
- Les disparitions ne se voient qu'à une **relecture complète** : toutes les 24 heures ou tous les 96 passages avec un
  repère, à chaque passage sans repère.
- **Le garde-fou** : si un passage allait marquer ou supprimer plus de lignes que `guard` ne le permet (20 % des lignes
  connues par défaut, et 10 au moins), ou si D1 rendait soudain zéro ligne, le passage s'arrête **avant d'écrire quoi
  que ce soit**, d'un côté comme de l'autre :

```sh
filarr-gate sources run xs_DemoClientsBoutique002 --json
```

```json
{ "state": "question", "code": "extdb_guard", "question": { "kind": "guard", "pass": "p_3fa9c1d2e0", "gone": 2, "total": 3 } }
```

Le journal de la synchro note l'arrêt lui-même (`{ "kind": "guard", "code": "extdb_guard", "n": 2 }`, `n` étant ce
que le passage aurait fait), jamais les lignes qu'il aurait marquées, et les compteurs de l'état restent à zéro : rien
n'a été écrit. Le **Journal** de la boîte noire elle-même nomme la cause, le nombre prévu et le seuil, et dit que rien
n'a été écrit.

Vérifiez d'abord D1 (une table tronquée, un mauvais filtre). Si les disparitions sont réelles, acceptez pour ce
passage seulement :

```sh
filarr-gate sources run xs_DemoClientsBoutique002 --ack-guard p_3fa9c1d2e0
```

(ou acceptez dans Filarr). L'accord vaut pour ce passage et ce nombre de lignes ; l'arrêt suivant redemande.

- **Trop de conflits d'un coup** (`extdb_conflict_burst`) arrêtent un passage de la même façon ; sur un premier
  passage, `--initial source` ou `--initial filarr` le tranche dans un sens, une fois.

## Fréquence, pause, lancer maintenant

- `15m`, `1h` (avec ± 10 % de variation), `1d` à une heure dans un fuseau horaire, ou à la demande ; la publication et
  les deux sens peuvent aussi tourner 10 secondes après un changement dans Filarr (au plus une fois toutes les 30
  secondes).
- Après un échec, la boîte noire réessaie au bout de 1, 2, 4… minutes, jusqu'à une fois par heure.
- `filarr-gate sources pause <id>` / `resume <id>` la mettent en pause sur cette boîte noire ; la définition reste dans
  Filarr.
- Deux processus lancés avec le même jeton ne font jamais tourner une synchro ensemble : le second voit
  `extdb_lease_held`.

## Ce que voit chacun

| | voit |
|---|---|
| Filarr | des blocs chiffrés, une validation par passage qui change quelque chose, un état scellé ; jamais la clé de D1, jamais une ligne |
| D1 | l'adresse IP de la boîte noire et le compte du jeton |
| les membres de la base | la définition (sans clé), l'état et le journal, valeurs remplacées comprises |
| la boîte noire | tout ce qu'elle synchronise, et la clé |

## Si ça ne marche pas

- `extdb_unsigned` : quelqu'un d'autre a changé la définition ; le créateur de l'accès l'approuve dans Filarr. Un accès
  créé avant l'étiquette du créateur doit voir son jeton remplacé.
- `extdb_key_refused` : D1 a refusé le jeton (401 ou 403) : permissions, compte, échéance.
- `extdb_tier` : les synchros planifiées demandent Solo ou plus.
- Tous les codes : [reference/errors.fr.md](../reference/errors.fr.md#états-dune-synchro-externe). La règle en
  détail : [explain/two-way-sync.fr.md](../explain/two-way-sync.fr.md).
- Dans l'aide de Filarr : [alimenter une base depuis une base externe](https://filarr.com/docs/external-databases),
  [synchroniser dans les deux sens](https://filarr.com/docs/two-way-sync) et
  [créer une clé limitée par connecteur](https://filarr.com/docs/external-databases-connectors).
