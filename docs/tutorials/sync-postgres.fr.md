# Un PostgreSQL de votre réseau local en miroir entrant, puis dans les deux sens

[Read in English](sync-postgres.md)

> **Bientôt, côté Filarr**, comme pour [D1](sync-d1.fr.md) : la boîte noire l'exécute dès aujourd'hui, et la suite
> d'essais exécute chaque étape de ce tutoriel côté boîte noire et côté PostgreSQL sur un vrai PostgreSQL jetable,
> avec le SQL exact de l'exemple et le rôle limité qu'il crée. Les écrans de Filarr qui créent la synchro arrivent avec
> une prochaine version de l'appli.

**À la fin**, un PostgreSQL que seul votre réseau peut joindre (la base de l'ERP sur `db.lan`) alimente une base
Filarr, par une boîte noire sur le même réseau, avec un rôle qui peut lire une table et rien d'autre ; puis la même
synchro passe dans les deux sens, avec « me demander » sur chaque colonne. Filarr ne peut jamais joindre votre
PostgreSQL : la boîte noire le fait, de l'intérieur.

**Palier :** Solo et plus. PostgreSQL demande la boîte noire Node ou Docker (TCP) ; pas la variante Cloudflare, pas la
boîte hébergée.

## 1. La table et son repère

[examples/sync-postgres/schema.sql](../../examples/sync-postgres/schema.sql), en administrateur de la base (`id` est
la clé de ligne sur laquelle la synchro associe les lignes, `updated_at` le repère) :

<!-- snippet: examples/sync-postgres/schema.sql#table -->
```sql
-- `id` is the row key the sync matches rows on. `updated_at` is the change marker.
CREATE TABLE IF NOT EXISTS commandes (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  numero     text NOT NULL UNIQUE,
  client     text NOT NULL,
  montant    numeric(12, 2) NOT NULL DEFAULT 0,
  statut     text NOT NULL DEFAULT 'Reçue',
  updated_at timestamptz NOT NULL DEFAULT now()
);
```

<!-- snippet: examples/sync-postgres/schema.sql#trigger -->
```sql
-- Keep `updated_at` right whoever writes (your ERP, a script, or the sync itself).
CREATE OR REPLACE FUNCTION commandes_touch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.updated_at IS NOT DISTINCT FROM OLD.updated_at THEN
    NEW.updated_at := now();
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS commandes_touch ON commandes;
CREATE TRIGGER commandes_touch BEFORE UPDATE ON commandes
FOR EACH ROW EXECUTE FUNCTION commandes_touch();
CREATE INDEX IF NOT EXISTS commandes_updated_at_idx ON commandes (updated_at);
```

`updated_at` est le repère ; le déclencheur le tient à jour qui que ce soit qui écrive (votre ERP, un script, ou la
synchro elle-même), et respecte un `UPDATE` qui le fixe explicitement. `numeric(12, 2)` ne pose pas de problème : la
boîte noire lit `1240.50` comme le nombre 1240.5, et quand PostgreSQL arrondit une valeur qu'elle réécrit, la boîte
noire relit la valeur arrondie dans le même passage (et arrête d'envoyer une colonne qui change sans cesse sous ses
pieds).

## 2. Un rôle qui ne peut faire que cela

[examples/sync-postgres/role.sql](../../examples/sync-postgres/role.sql). Pour un miroir (PostgreSQL → Filarr), la
lecture suffit :

<!-- snippet: examples/sync-postgres/role.sql#readonly -->
```sql
-- Inbound mirror (PostgreSQL → Filarr): reading is enough
CREATE ROLE filarr_gate LOGIN PASSWORD 'choose-a-long-password';
GRANT CONNECT ON DATABASE atelier TO filarr_gate;
GRANT USAGE ON SCHEMA public TO filarr_gate;
GRANT SELECT ON public.commandes TO filarr_gate;
```

Pour publier ou synchroniser dans les deux sens, ajoutez l'écriture sur cette seule table (écrire les colonnes
associées, insérer, supprimer) :

<!-- snippet: examples/sync-postgres/role.sql#readwrite -->
```sql
-- Publishing (Filarr → PostgreSQL) or both ways: write the mapped columns, insert, delete
GRANT INSERT, UPDATE, DELETE ON public.commandes TO filarr_gate;
```

Choisissez votre propre mot de passe ; il va à la boîte noire, jamais à Filarr. La suite d'essais crée exactement ce
rôle et s'y connecte : ces droits suffisent, pour le miroir comme pour les deux sens (insertion avec `RETURNING`
comprise).

## 3. TLS

La définition dit comment la boîte noire se connecte (`conn.tls`) :

- `verify-full` (par défaut) : TLS, certificat vérifié par rapport au nom d'hôte. Employez-le dès que PostgreSQL a un
  certificat.
- `require` : TLS sans vérifier le certificat (chiffré, mais une machine au milieu pourrait se faire passer pour le
  serveur).
- `off-local` : pas de TLS. Permis seulement pour un hôte du réseau local (plages privées, noms en `.lan`, `.local`,
  `.internal`, `.home.arpa`) ; Filarr l'affiche en rouge. C'est ce qu'emploie l'exemple, pour `db.lan`.

## 4. Une boîte noire sur le même réseau

Installez la boîte noire sur une machine qui joint `db.lan:5432` : [avec Docker](install-docker.fr.md) sur le serveur
de l'ERP, ou [sur un ordinateur](install-local.fr.md). Le pilote PostgreSQL (`pg`) est livré avec la boîte noire.

## 5. Dans Filarr : le miroir (bientôt)

Sur la base Filarr « Commandes », « ··· » › « Alimenter depuis une base externe… » : PostgreSQL, hôte `db.lan`, port
5432, base `atelier`, utilisateur `filarr_gate`, TLS ; la table `commandes` ; `id` comme clé de ligne, `updated_at`
comme repère ; sens **miroir entrant** ; exécutant : cette boîte noire ; toutes les 15 minutes. Filarr signe la
définition ([definition.mirror.json](../../examples/sync-postgres/definition.mirror.json)) :

<!-- snippet: examples/sync-postgres/definition.mirror.json -->
```json
{
  "v": 1,
  "id": "xs_DemoCommandesAtelier00",
  "rev": 1,
  "name": "Commandes de l'atelier (miroir)",
  "connector": "postgres",
  "conn": { "host": "db.lan", "port": 5432, "db": "atelier", "user": "filarr_gate", "schema": "public", "tls": "off-local" },
  "host": "db.lan:5432",
  "from": { "table": "commandes" },
  "key": { "cols": ["id"], "gen": "source" },
  "marker": { "col": "updated_at", "kind": "iso" },
  "mode": "mirror",
  "map": [
    { "col": "id", "prop": "p_id", "dir": "in", "type": "number" },
    { "col": "numero", "prop": "p_numero", "dir": "in", "type": "text" },
    { "col": "client", "prop": "p_client", "dir": "in", "type": "text" },
    { "col": "montant", "prop": "p_montant", "dir": "in", "type": "number" },
    { "col": "statut", "prop": "p_statut", "dir": "in", "type": "select" }
  ],
  "onGone": "mark",
  "guard": { "pct": 20, "min": 10 },
  "runner": { "kind": "gate", "accessId": "<the access id>", "name": "Serveur de l'atelier" },
  "schedule": { "every": "15m", "tz": "Europe/Paris" },
  "signer": "<the user id of the access creator>",
  "sig": "<signature by the creator's identity key>"
}
```

## 6. Le mot de passe à la boîte noire, un premier passage

```sh
printf '%s' "$PG_PASSWORD" | filarr-gate sources key xs_DemoCommandesAtelier00 --stdin
filarr-gate sources run xs_DemoCommandesAtelier00
```

```text
Clé enregistrée (chiffrée sur cette machine).
Passage : ok
```

Les commandes sont dans Filarr. `statut` est une colonne de sélection : chaque libellé que tient PostgreSQL (`Reçue`,
`Expédiée`) en est devenu une option. Les colonnes associées sont verrouillées dans Filarr ; ajoutez vos propres
colonnes (une colonne « Suivi » pour vos notes) : elles restent à vous.

## 7. Dans les deux sens, avec « me demander »

Changez la définition dans Filarr : sens **dans les deux sens**, politique **Me demander** pour les cellules et pour
les lignes. Elle devient la révision 2 de la même définition, signée de nouveau ; la boîte noire garde sa référence et
continue ([definition.both.json](../../examples/sync-postgres/definition.both.json)) :

<!-- snippet: examples/sync-postgres/definition.both.json -->
```json
{
  "v": 1,
  "id": "xs_DemoCommandesAtelier00",
  "rev": 2,
  "name": "Commandes de l'atelier",
  "connector": "postgres",
  "conn": { "host": "db.lan", "port": 5432, "db": "atelier", "user": "filarr_gate", "schema": "public", "tls": "off-local" },
  "host": "db.lan:5432",
  "from": { "table": "commandes" },
  "key": { "cols": ["id"], "gen": "source" },
  "marker": { "col": "updated_at", "kind": "iso" },
  "mode": "both",
  "map": [
    { "col": "id", "prop": "p_id", "dir": "in", "type": "number" },
    { "col": "numero", "prop": "p_numero", "dir": "both", "type": "text" },
    { "col": "client", "prop": "p_client", "dir": "both", "type": "text" },
    { "col": "montant", "prop": "p_montant", "dir": "in", "type": "number" },
    { "col": "statut", "prop": "p_statut", "dir": "both", "type": "select" }
  ],
  "conflict": "ask",
  "rowConflict": "ask",
  "onGone": "mark",
  "onFilarrDelete": "ignore",
  "guard": { "pct": 20, "min": 10 },
  "runner": { "kind": "gate", "accessId": "<the access id>", "name": "Serveur de l'atelier" },
  "schedule": { "every": "15m", "tz": "Europe/Paris" },
  "signer": "<the user id of the access creator>",
  "sig": "<signature by the creator's identity key>"
}
```

Ce que fait alors la suite d'essais, et ce qu'elle voit :

1. Filarr passe le statut de `C-2026-1181` à « Reçue » ; l'ERP le met à « Livrée » dans PostgreSQL. Le passage suivant
   n'écrit rien pour cette cellule, et l'état dit `extdb_conflicts_pending`, un conflit.
2. Quelqu'un le tranche dans Filarr : **garder la valeur de Filarr**. La décision déclenche un passage, et PostgreSQL
   reçoit « Reçue » (un `UPDATE … WHERE id = $1 AND statut IS NOT DISTINCT FROM $2` : si l'ERP avait encore changé la
   cellule entre-temps, rien ne serait écrasé, et le conflit reviendrait).
3. Une ligne créée dans Filarr (`C-2026-1200`, Initech) est insérée dans PostgreSQL au passage suivant ; l'`id` que
   PostgreSQL lui donne revient dans Filarr.

Un passage vers PostgreSQL est une transaction : si quelque chose échoue, rien de ce passage n'est écrit dans la
source.

## Bon à savoir

- `onFilarrDelete: "ignore"` dans l'exemple : supprimer une commande dans Filarr ne la supprime pas dans l'ERP ; la
  boîte noire le note et ne l'importe plus jamais, sauf si elle est restaurée dans Filarr.
- La synchro ne lit que les colonnes associées (et la clé et le repère) :
  `SELECT "id", "numero", … FROM "public"."commandes"`.
- Une source écrite comme une requête (`from.query`, un `SELECT`) se lit dans une transaction en lecture seule et ne
  peut servir qu'en miroir entrant.
- 100 000 lignes au plus par définition, pour une boîte noire.

## Si ça ne marche pas

- `extdb_unreachable` : la machine de la boîte noire ne joint pas `db.lan:5432` (pare-feu, `pg_hba.conf`,
  `listen_addresses`).
- `extdb_key_refused` : mauvais mot de passe, ou `pg_hba.conf` refuse le rôle depuis l'adresse de la boîte noire.
- `extdb_tls` : le certificat ne correspond pas à l'hôte ; corrigez-le, ou choisissez `require`.
- `extdb_not_found` : la base ou la table n'existe pas (ou le rôle ne la voit pas).
- Plus de cas : [dépannage](../troubleshooting.fr.md#synchros-externes).
- Dans l'aide de Filarr : [alimenter une base depuis une base externe](https://filarr.com/docs/external-databases),
  [synchroniser dans les deux sens](https://filarr.com/docs/two-way-sync) et
  [créer une clé limitée par connecteur](https://filarr.com/docs/external-databases-connectors).
