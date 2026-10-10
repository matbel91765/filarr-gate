# Les bases externes

[Read in English](external-databases.md)

Une base Filarr peut être alimentée depuis une autre base, ou publiée vers elle (contrat `source-externe-1`). La
synchro est **définie dans Filarr** (« ··· » sur une base › « Alimenter depuis une base externe… ») et **exécutée par
l'exécutant qu'elle nomme** : un appareil, ou cette boîte noire. Une boîte noire exécute les définitions qui nomment son
accès, avec les clés que vous lui donnez ici ; ces clés n'atteignent jamais Filarr.

## Ce que la boîte noire vérifie avant d'exécuter

- La définition est signée par le créateur de l'accès (Ed25519, la clé d'identité authentifiée par l'étiquette du
  créateur) ; une définition non signée ou signée par un autre s'affiche « en attente de la signature du créateur » et
  ne tourne jamais.
- Elle est valide (connecteur, hôte qui correspond à la connexion, requêtes `SELECT` seulement, colonnes clés
  associées, une politique de conflit pour les colonnes dans les deux sens…), le palier permet les synchros planifiées
  (Solo et plus), et la clé est présente.
- La boîte noire tient le **bail** de la définition chez Filarr : deux processus lancés avec le même jeton ne font
  jamais de passage en même temps. Chaque processus tire son propre identifiant d'instance au démarrage et l'envoie avec
  le bail ; le second attend, et son journal dit « une autre instance de cette boîte noire exécute déjà cette synchro ».
  Un processus arrêté proprement rend son bail. La variante Cloudflare garde un seul identifiant d'instance dans son
  Durable Object, qui reste le même exécutant d'une éviction à l'autre.
- Une colonne de la source qui est une relation (une relation Notion, des enregistrements liés Airtable) est refusée
  (`unsupported_column`) : les relations entrantes ne sont pas encore prises en charge, et elles ne sont jamais
  importées en texte.

## Donner la clé

| connecteur | clé |
|---|---|
| Cloudflare D1 | un jeton d'API avec l'accès à D1 |
| PostgreSQL, MySQL | le mot de passe de l'utilisateur de la base (TCP : Node et Docker seulement) |
| Supabase | la clé du rôle de service |
| Airtable | un jeton d'accès personnel |
| Google Sheets | le JSON du compte de service |
| Notion | le jeton de l'intégration |
| CSV/JSON par URL | un jeton porteur facultatif |

Dans l'interface (**Sources** : conservée chiffrée sous une clé tirée du jeton), avec
`filarr-gate sources key <id> --stdin`, dans `FILARR_GATE_EXTDB_<ID>` (le nom exact s'affiche sur la source), ou dans
`gate.toml` :

```toml
[extdb."xs_…"]
secret = "…"
```

Une base locale (`127.0.0.1`, un hôte en `.lan`…) peut être jointe sans TLS quand la définition dit `tls: off-local` ;
tout le reste passe par HTTPS ou TLS.

## Un passage

1. Bail pris ; décisions lues dans la boîte aux lettres de Filarr (des conflits tranchés par un membre).
2. La source lue (en entier, ou depuis le repère), les lignes de Filarr lues dans la copie locale.
3. Chaque cellule confrontée à la **référence** (la dernière valeur sur laquelle les deux côtés étaient d'accord) :
   la source a changé, Filarr a changé, les deux, ou aucun. Les colonnes dans les deux sens suivent leur politique :
   `source`, `filarr`, `latest` (par le repère de date de la ligne), ou `ask` : la cellule entre dans la file, n'est
   écrite nulle part, et se tranche dans Filarr ; le reste de la ligne se synchronise.
4. **Les garde-fous** arrêtent un passage avant toute écriture : trop de lignes disparues de la source (`guard.pct`, au
   moins `guard.min`), ou une rafale de conflits sur un premier passage. Donnez votre accord dans Filarr (ou
   `filarr-gate sources run <id> --ack-guard <passage>`) pour continuer, pour ce passage seulement. Un passage arrêté
   note au journal l'arrêt et le nombre prévu, jamais les lignes qu'il aurait touchées ; ses compteurs restent à zéro.
5. Les écritures dans la source sous condition de la valeur lue (une valeur changée entre-temps n'est pas écrasée),
   puis une validation dans Filarr. La référence et l'état publié (chiffré sous une clé de la base, lisible par ses
   membres, jamais par Filarr) sont enregistrés ; les webhooks `sync.done` ou `sync.failed` partent.

Les lignes supprimées dans la source sont marquées « disparues » (`onGone: mark`), supprimées, ou gardées, comme le dit
la définition. Les colonnes alimentées par la source ne s'écrivent pas par l'API locale (`409 field_managed`), et une
base en miroir refuse les nouvelles lignes et les suppressions (`409 rows_managed`).

## Les fréquences

`15m`, `1h`, `1d` (à une heure donnée, dans un fuseau horaire), `manual`, et « à chaque changement » pour la
publication. **Lancer maintenant** dans l'interface ou `filarr-gate sources run <id>` ; **Mettre en pause** garde la
définition et arrête les passages.
