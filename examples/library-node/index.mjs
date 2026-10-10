// The library @filarr/gate in a Node program: read a view, listen to changes, stop cleanly.
//
//   npm install @filarr/gate
//   FILARR_GATE_TOKEN=flr_live_… node index.mjs
//
// FILARR_GATE_API_URL only serves the tests (a local Filarr); by default, Filarr's API.
import { openGate } from '@filarr/gate';

// region open
const gate = await openGate({
  token: process.env.FILARR_GATE_TOKEN,
  ...(process.env.FILARR_GATE_API_URL ? { apiUrl: process.env.FILARR_GATE_API_URL } : {}),
});
// endregion

// region read
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
// endregion

// region live
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
// endregion
console.log('ready');
// EXAMPLE_SECONDS limits the run, for the tests
if (process.env.EXAMPLE_SECONDS) setTimeout(stop, Number(process.env.EXAMPLE_SECONDS) * 1000);
