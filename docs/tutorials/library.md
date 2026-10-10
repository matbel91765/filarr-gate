# Read a Filarr database in your Node program

[Lire en français](library.fr.md)

**At the end** your own program opens the databases of an access with `@filarr/gate`, reads rows, views and SQL,
receives each change made in Filarr as it happens, writes rows, and stops cleanly: no HTTP server, no app key, the
gate inside your process.

**Plan:** reading on every plan; live changes and writes from Solo.

## When to use the library rather than the server

| | the library `@filarr/gate` | the server `filarr-gate` |
|---|---|---|
| who reads | one program, yours | any software over HTTP |
| keys | your program holds the token | each program gets its own app key; the token stays in the gate |
| extras | none | webhooks, MCP, SQL over HTTP, file slot over HTTP, management UI, external syncs |
| where | Node 20.19+ (tested); standard Web APIs only, so Deno, Bun and Workers should run it (untested there) | Node, Docker, Cloudflare |

The token opens the databases: give it only to a program you would give the data to.

## 1. Install

```sh
npm install @filarr/gate
```

To try a change that is not released yet: from a clone of this repository, `npm ci && npm run build`, then
`npm install /path/to/filarr-gate/packages/gate`.

## 2. Open, read

The complete program is [examples/library-node/index.mjs](../../examples/library-node/index.mjs); the test suite runs
it against a gate's in-memory Filarr, and makes a change in Filarr while it listens.

<!-- snippet: examples/library-node/index.mjs#open -->
```js
const gate = await openGate({
  token: process.env.FILARR_GATE_TOKEN,
  ...(process.env.FILARR_GATE_API_URL ? { apiUrl: process.env.FILARR_GATE_API_URL } : {}),
});
```

`openGate()` returns once the first copy is ready: it reads the access, checks every sealed key, downloads and
decrypts the blocks. It throws a `GateError` with `api_access_revoked`, `api_access_expired` or `api_access_unknown`
when the token is no longer valid.

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

- `rows({ where, sort, limit, cursor, fields, q, since })`: `where` takes a value (equals) or operators
  (`{ ca: { gte: 1000 } }`, `{ statut: { in: ['Client', 'Prospect'] } }`, `{ ville: { empty: true } }`). The result
  is an array with `next`, `total` and `version`.
- `row(id)` returns one row or `null`; `view(slug).rows({ limit, cursor })` a view; `sql(query)` a read-only query.
- `bases()` and each base's `fields` describe the columns: `name`, `column` (its name in Filarr), `type`, `json`,
  `writable`, `options`.

## 3. Listen to changes

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

Each `change` event gives the base, the new `version`, the rows `added`, `changed` (with `before` and `after`) and
`removed`, and `origin`: `filarr` (written in Filarr) or `gate` (written by this program). On Solo and above the gate
keeps a live stream open; on Free it polls at the interval of the plan. `status` events tell the link's state.

`openGate({ live: false })` makes one copy and stops there: right for a short script; call `refresh()` to read again.

## 4. Write

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

Writing needs `openGate({ write: true })`, the database in **read and write** on the access, and a plan with API
writes. Each `insert`, `update` or `delete` is one commit in Filarr (an array of rows: still one). A refusal is a
`GateError`:

<!-- snippet: examples/library-node/write.mjs#errors -->
```js
// A refusal is a GateError with a stable code
try {
  await clients.update('db-does-not-exist', { nom: 'x' });
} catch (err) {
  console.log(`refused: ${err.name} ${err.status} ${err.code}`);
}
```

The codes are those of the server's local API: [reference/errors.md](../reference/errors.md).

## 5. Keep encrypted blocks between runs (optional)

```js
const gate = await openGate({ token, cache: { dir: '/var/cache/my-app/filarr' } });
```

The folder keeps the encrypted blocks exactly as Filarr stores them, never a decrypted row; the next start downloads
only what changed. By default the cache is in memory.

## Things to know

- **Field names** follow the column names (`Dernier contact` → `dernier_contact`). The server keeps a name once it is
  given, so renaming a column in Filarr does not break your software; the library computes names at each start, so
  after a rename, the next start uses the new name. Read `base.fields` if you depend on names.
- `close()` stops the replica and wipes the keys and the rows from memory. Call it on exit.
- Relations to a database the access does not open give raw ids, rollups over it give `null`, and the field is listed
  in `unresolved`.
- The library talks to Filarr only: requests to Filarr count against the plan (sync requests, downloaded volume,
  commits); your reads from the copy are never counted.
- The whole API: [reference/library.md](../reference/library.md).

## If it does not work

- `base_not_found`: the slug is not one of the access's databases; `gate.bases()` lists them.
- `503 key_missing` on a database: the creator must open Filarr to re-seal its keys.
- More: [troubleshooting](../troubleshooting.md).
