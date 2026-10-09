// La bibliothèque @filarr/gate dans un programme Node : lire une vue, écouter les
// changements, s'arrêter proprement.
//
//   npm install @filarr/gate
//   FILARR_GATE_TOKEN=flr_live_… node index.mjs
//
// FILARR_GATE_API_URL ne sert qu'aux essais (un Filarr local) ; d'office, l'API de Filarr.
import { openGate } from '@filarr/gate';

const gate = await openGate({
  token: process.env.FILARR_GATE_TOKEN,
  ...(process.env.FILARR_GATE_API_URL ? { apiUrl: process.env.FILARR_GATE_API_URL } : {}),
});

// Les bases que le jeton ouvre, et leurs vues
for (const base of gate.bases()) {
  console.log(`base ${base.slug} (${base.rows} lignes) : vues ${base.views.map((v) => v.slug).join(', ')}`);
}

// Une vue, rejouée par le moteur de vues de Filarr
const actifs = await gate.base('clients').view('clients-actifs').rows();
for (const row of actifs) console.log(`actif : ${row.nom} (${row.ville})`);

// Des lignes filtrées et triées, page par page
const page = await gate.base('clients').rows({ where: { ca: { gte: 1000 } }, sort: '-ca', limit: 2 });
console.log(`premières : ${page.map((r) => r.nom).join(', ')} · ${page.total} au total · suite : ${page.next ?? 'aucune'}`);

// SQL en lecture seule
const { rows } = await gate.sql('SELECT ville, count(*) AS n FROM clients GROUP BY ville ORDER BY ville');
console.log(`par ville : ${rows.map(([ville, n]) => `${ville}=${n}`).join(' ')}`);

// Les changements faits dans Filarr, en direct
const off = gate.on('change', (event) => {
  for (const { after } of event.changed) console.log(`changé dans ${event.base} : ${after.nom} → ${after.ville}`);
});

// Arrêt propre (Ctrl+C) ; EXAMPLE_SECONDS limite la durée pour les essais
const stop = async () => {
  off();
  await gate.close();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
console.log('prêt');
if (process.env.EXAMPLE_SECONDS) setTimeout(stop, Number(process.env.EXAMPLE_SECONDS) * 1000);
