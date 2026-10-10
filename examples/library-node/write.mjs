// Writing with the library @filarr/gate: add, change and delete rows from your own code.
//
//   npm install @filarr/gate
//   FILARR_GATE_TOKEN=flr_live_… node write.mjs
//
// Writing needs `write: true` here, a "read and write" right on the database in Filarr, and a
// plan with API writes. Each call is one commit in Filarr (an array of rows: still one).
// FILARR_GATE_API_URL only serves the tests (a local Filarr); by default, Filarr's API.
import { openGate } from '@filarr/gate';

const gate = await openGate({
  token: process.env.FILARR_GATE_TOKEN,
  write: true,
  live: false, // a short script: one copy at the start is enough, no live stream
  ...(process.env.FILARR_GATE_API_URL ? { apiUrl: process.env.FILARR_GATE_API_URL } : {}),
});

try {
  // region write
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
  // endregion

  // region errors
  // A refusal is a GateError with a stable code
  try {
    await clients.update('db-does-not-exist', { nom: 'x' });
  } catch (err) {
    console.log(`refused: ${err.name} ${err.status} ${err.code}`);
  }
  // endregion
} finally {
  await gate.close();
}
