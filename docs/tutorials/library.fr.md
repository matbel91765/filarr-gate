# Lire une base Filarr dans votre programme Node

[Read in English](library.md)

**À la fin**, votre propre programme ouvrira les bases d'un accès avec `@filarr/gate`, lira des lignes et des vues,
exécutera du SQL, recevra chaque changement fait dans Filarr au moment où il arrive, écrira des lignes, et s'arrêtera
proprement : pas de serveur HTTP, pas de clé d'application, la boîte noire dans votre processus.

**Palier :** la lecture à tous les paliers ; les changements en direct et l'écriture à partir de Solo.

## Quand prendre la bibliothèque plutôt que le serveur

| | la bibliothèque `@filarr/gate` | le serveur `filarr-gate` |
|---|---|---|
| qui lit | un programme, le vôtre | n'importe quel logiciel, par HTTP |
| clés | votre programme tient le jeton | chaque programme reçoit sa clé d'application ; le jeton reste dans la boîte noire |
| en plus | rien | webhooks, MCP, SQL par HTTP, fente à fichiers par HTTP, interface de gestion, synchros externes |
| où | Node 20.19+ (éprouvé) ; des API web standard seulement, donc Deno, Bun et les Workers devraient la faire tourner (non éprouvé) | Node, Docker, Cloudflare |

Le jeton ouvre les bases : ne le donnez qu'à un programme auquel vous donneriez les données.

## 1. Installer

```sh
npm install @filarr/gate
```

Pour essayer un changement pas encore publié : depuis un clone de ce dépôt, `npm ci && npm run build`, puis
`npm install /chemin/vers/filarr-gate/packages/gate`.

## 2. Ouvrir, lire

Le programme complet est [examples/library-node/index.mjs](../../examples/library-node/index.mjs) ; la suite d'essais
l'exécute face au Filarr en mémoire d'une boîte noire, et fait un changement dans Filarr pendant qu'il écoute.

<!-- snippet: examples/library-node/index.mjs#open -->
```js
const gate = await openGate({
  token: process.env.FILARR_GATE_TOKEN,
  ...(process.env.FILARR_GATE_API_URL ? { apiUrl: process.env.FILARR_GATE_API_URL } : {}),
});
```

`openGate()` rend la main une fois la première copie prête : il lit l'accès, vérifie chaque clé scellée, télécharge et
déchiffre les blocs. Il lève une `GateError` avec `api_access_revoked`, `api_access_expired` ou `api_access_unknown`
quand le jeton n'est plus valide.

L'extrait suivant liste les bases que le jeton ouvre et leurs vues, lit une vue rejouée par le moteur de vues de
Filarr, des lignes filtrées et triées page par page, puis une requête SQL en lecture seule :

<!-- snippet: examples/library-node/index.mjs#read -->
```js
// The databases the token opens, and their views
for (const base of gate.bases()) {
  console.log(`database ${base.slug} (${base.rows} rows): views ${base.views.map((v) => v.slug).join(', ')}`);
}

// A view, replayed by Filarr's own view engine
const active = await gate.base('clients').view('clients-actifs').rows();
for (const row of active) console.log(`active: ${row.nom} (${row.ville})`);

// Rows filtered and sorted, page by page
const page = await gate.base('clients').rows({ where: { ca: { gte: 1000 } }, sort: '-ca', limit: 2 });
console.log(`first: ${page.map((r) => r.nom).join(', ')} · ${page.total} in all · next: ${page.next ?? 'none'}`);

// Read-only SQL
const { rows } = await gate.sql('SELECT ville, count(*) AS n FROM clients GROUP BY ville ORDER BY ville');
console.log(`per city: ${rows.map(([ville, n]) => `${ville}=${n}`).join(' ')}`);
```

```text
database clients (4 rows): views tous-les-clients, clients-actifs, a-relancer
active: Acme (Lyon)
active: Globex (Nantes)
first: Acme, Globex · 3 in all · next: o2
per city: Lille=1 Lyon=1 Nantes=1 Paris=1
```

- `rows({ where, sort, limit, cursor, fields, q, since })` : `where` prend une valeur (égal) ou des opérateurs
  (`{ ca: { gte: 1000 } }`, `{ statut: { in: ['Client', 'Prospect'] } }`, `{ ville: { empty: true } }`). Le résultat
  est un tableau avec `next`, `total` et `version`.
- `row(id)` rend une ligne ou `null` ; `view(slug).rows({ limit, cursor })` une vue ; `sql(query)` une requête en
  lecture seule.
- `bases()` et les `fields` de chaque base décrivent les colonnes : `name`, `column` (son nom dans Filarr), `type`,
  `json`, `writable`, `options`.

## 3. Écouter les changements

L'extrait écoute les changements faits dans Filarr, en direct, et s'arrête proprement sur Ctrl+C : les clés et les
lignes sont effacées de la mémoire.

<!-- snippet: examples/library-node/index.mjs#live -->
```js
// The changes made in Filarr, live
const off = gate.on('change', (event) => {
  for (const { after } of event.changed) console.log(`changed in ${event.base}: ${after.nom} → ${after.ville}`);
});

// Stop cleanly (Ctrl+C): the keys and the rows are wiped from memory
const stop = async () => {
  off();
  await gate.close();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
```

Chaque événement `change` donne la base, la nouvelle `version`, les lignes ajoutées (`added`), changées (`changed`,
avec `before` et `after`) et retirées (`removed`), et `origin` : `filarr` (écrit dans Filarr) ou `gate` (écrit par ce
programme). À partir de Solo, la boîte noire garde un flux en direct ouvert ; en Free, elle relève au rythme du palier.
Les événements `status` disent l'état de la liaison.

`openGate({ live: false })` fait une copie et s'en tient là : c'est ce qu'il faut pour un script court ; appelez
`refresh()` pour relire.

## 4. Écrire

L'extrait ajoute une ligne (les colonnes non données prennent leur valeur par défaut, ici le statut « Prospect »),
puis plusieurs lignes en UNE validation, change quelques champs (les autres restent tels quels) et supprime ce qu'il a
créé (une ligne supprimée peut être restaurée dans Filarr) :

<!-- snippet: examples/library-node/write.mjs#write -->
```js
const clients = gate.base('clients');
console.log(`fields: ${clients.fields.filter((f) => f.writable).map((f) => `${f.name} (${f.json})`).join(', ')}`);

// One row: the columns not given get their default value (here the status "Prospect")
const hooli = await clients.insert({ nom: 'Hooli', ville: 'Bordeaux', ca: 4200 });
console.log(`added ${hooli.nom}: ${hooli.statut}`);

// Several rows in ONE commit
const added = await clients.insert([{ nom: 'Pied Piper' }, { nom: 'Raviga', ville: 'Paris' }]);
console.log(`added ${added.length} more`);

// Change some fields; the others stay as they are
const updated = await clients.update(hooli.id, { statut: 'Client', ca: 5100 });
console.log(`updated ${updated.nom}: ${updated.statut}, ${updated.ca}`);

// Delete (it can be restored in Filarr)
for (const row of [hooli, ...added]) await clients.delete(row.id);
console.log(`deleted 3; ${(await clients.rows()).total} rows left`);
```

```text
added Hooli: Prospect
added 2 more
updated Hooli: Client, 5100
deleted 3; 4 rows left
```

L'écriture demande `openGate({ write: true })`, la base en **lecture et écriture** sur l'accès, et un palier qui
comprend l'écriture par l'API. Chaque `insert`, `update` ou `delete` fait une validation dans Filarr (un tableau de
lignes : une seule aussi). Un refus est une `GateError` avec un code stable :

<!-- snippet: examples/library-node/write.mjs#errors -->
```js
// A refusal is a GateError with a stable code
try {
  await clients.update('db-does-not-exist', { nom: 'x' });
} catch (err) {
  console.log(`refused: ${err.name} ${err.status} ${err.code}`);
}
```

Les codes sont ceux de l'API locale du serveur : [reference/errors.fr.md](../reference/errors.fr.md).

## 5. Garder les blocs chiffrés d'un lancement à l'autre (facultatif)

```js
const gate = await openGate({ token, cache: { dir: '/var/cache/mon-appli/filarr' } });
```

Le dossier garde les blocs chiffrés tels que Filarr les garde, jamais une ligne déchiffrée ; le démarrage suivant ne
télécharge que ce qui a changé. Par défaut, le cache est en mémoire.

## Bon à savoir

- **Les noms de champs** suivent les noms des colonnes (`Dernier contact` → `dernier_contact`). Le serveur garde un nom
  une fois donné, pour que renommer une colonne dans Filarr ne casse pas vos logiciels ; la bibliothèque calcule les
  noms à chaque démarrage : après un renommage, le démarrage suivant emploie le nouveau nom. Lisez `base.fields` si
  vous dépendez des noms.
- `close()` arrête la réplique et efface les clés et les lignes de la mémoire. Appelez-la en sortant.
- Les relations vers une base que l'accès n'ouvre pas rendent des identifiants bruts, les agrégats sur elle rendent
  `null`, et le champ est listé dans `unresolved`.
- La bibliothèque ne parle qu'à Filarr : ses requêtes à Filarr sont décomptées des limites du palier (requêtes de
  synchro, volume téléchargé, validations) ; vos lectures dans la copie ne sont jamais comptées.
- Toute l'API : [reference/library.fr.md](../reference/library.fr.md).

## Si ça ne marche pas

- `base_not_found` : le slug n'est pas celui d'une base de l'accès ; `gate.bases()` les liste.
- `503 key_missing` sur une base : le créateur doit ouvrir Filarr pour resceller ses clés.
- Plus de cas : [dépannage](../troubleshooting.fr.md).
