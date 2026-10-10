// First calls to the local API of Filarr Gate, with fetch (Node 20+, Deno, Bun).
//
//   FILARR_GATE_URL=http://127.0.0.1:8443 FILARR_GATE_KEY=gk_… node calls.mjs
//
// The app key needs: read on the "clients" database, the SQL right, and the create, update
// and delete rights on "clients" (writes also need `write` switched on in the gate).
// It runs against the demo databases of `npm run mock-filarr`.
import { randomUUID } from 'node:crypto';

const GATE = process.env.FILARR_GATE_URL ?? 'http://127.0.0.1:8443';
const KEY = process.env.FILARR_GATE_KEY;
if (!KEY) throw new Error('Set FILARR_GATE_KEY to an app key (gk_…)');

// region client
/** One call to the gate: JSON in and out, the `code` of a refusal kept, `Retry-After` honoured. */
async function gate(method, path, { body, headers = {}, retries = 3 } = {}) {
  for (let attempt = 0; ; attempt += 1) {
    const res = await fetch(new URL(path, GATE), {
      method,
      headers: {
        Authorization: `Bearer ${KEY}`,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...headers,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (res.status === 429 && attempt < retries) {
      const wait = Number(res.headers.get('retry-after') ?? '1');
      console.log(`429: waiting ${wait} s before trying again`);
      await new Promise((resolve) => setTimeout(resolve, wait * 1000));
      continue;
    }
    const data = await res.json();
    if (!res.ok) {
      throw Object.assign(new Error(`${res.status} ${data.code}: ${data.error}`), { status: res.status, code: data.code, data });
    }
    return { data, headers: res.headers };
  }
}
// endregion

// region list
// Customers with a turnover of 1000 or more, largest first, two per page, three fields
const query = 'ca[gte]=1000&sort=-ca&fields=nom,ville,ca&limit=2';
let page = (await gate('GET', `/v1/clients?${query}`)).data;
console.log(`${page.total} customers match (version ${page.version})`);
for (;;) {
  for (const row of page.rows) console.log(`  ${row.nom} (${row.ville}): ${row.ca}`);
  if (!page.next) break;
  page = (await gate('GET', `/v1/clients?${query}&cursor=${page.next}`)).data;
}
// endregion

// region view
// A view of Filarr, replayed by Filarr's own view engine: its filters, sort and columns
const view = (await gate('GET', '/v1/clients/clients-actifs')).data;
console.log(`view "${view.view.name}": ${view.rows.map((r) => r.nom).join(', ')}`);
// endregion

// region sql
// Read-only SQL (SQLite dialect) over the databases the key can read
const sql = (await gate('POST', '/v1/sql', { body: { sql: 'SELECT ville, count(*) AS n FROM clients GROUP BY ville ORDER BY ville' } })).data;
console.log(`per city: ${sql.rows.map(([ville, n]) => `${ville}=${n}`).join(' ')}`);
// endregion

// region write
// Create a row. The Idempotency-Key makes a retry safe: the second call writes nothing.
const idempotencyKey = randomUUID();
const newCustomer = { nom: 'Hooli', ville: 'Bordeaux', ca: 4200 };
const created = await gate('POST', '/v1/clients', { body: newCustomer, headers: { 'Idempotency-Key': idempotencyKey } });
const replay = await gate('POST', '/v1/clients', { body: newCustomer, headers: { 'Idempotency-Key': idempotencyKey } });
const id = created.data.id;
console.log(`created ${created.data.row.nom}, status ${created.data.row.statut} (the column's default), id ${id.slice(0, 3)}…`);
console.log(`sent again with the same Idempotency-Key: replayed=${replay.headers.get('idempotency-replayed')}, same id: ${replay.data.id === id}`);

// Change one field (the others are left as they are), then delete the row
const updated = (await gate('PATCH', `/v1/clients/rows/${id}`, { body: { statut: 'Client' } })).data;
console.log(`updated: statut=${updated.row.statut}`);
await gate('DELETE', `/v1/clients/rows/${id}`);
console.log('deleted');
// endregion

// region errors
// A refusal carries a stable `code` (and details): match on it, not on the message
try {
  await gate('GET', '/v1/clients?couleur=bleu');
} catch (err) {
  console.log(`refused: ${err.status} ${err.code} (field: ${err.data.field})`);
}
// endregion
