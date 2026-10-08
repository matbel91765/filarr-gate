/**
 * Banc local : un Filarr en mémoire (le même que celui des essais), avec trois
 * bases de démonstration ouvertes à un accès, et un geste de l'application
 * toutes les 20 secondes pour voir les changements arriver.
 *
 *   npm run mock-filarr                         # palier Pro, écriture ouverte
 *   MOCK_TIER=free npm run mock-filarr          # palier Free (sans flux, relève)
 *   MOCK_PORT=8790 npm run mock-filarr
 *
 * Puis, dans un autre terminal :
 *   FILARR_GATE_API_URL=http://127.0.0.1:8790 FILARR_GATE_TOKEN=<jeton affiché> npx filarr-gate
 *
 * Ce n'est PAS le worker de Filarr : pour éprouver la boîte noire contre le vrai
 * worker, lancez `wrangler dev` dans filarg/infra/cloudflare-worker et pointez
 * FILARR_GATE_API_URL vers lui.
 */

import { CATALOGUE_DB, CLIENTS_DB, COMMANDES_DB, demoStores } from '../test/support/demoData';
import { MockFilarr, type Tier } from '../test/support/mockFilarr';

const port = Number(process.env.MOCK_PORT ?? 8790);
const tier = (process.env.MOCK_TIER ?? 'pro') as Tier;

const mock = new MockFilarr({ writeSwitch: process.env.MOCK_WRITE !== 'false' });
const url = await mock.listen(port, process.env.MOCK_HOST ?? '127.0.0.1');
const stores: Record<string, string> = {};
for (const spec of demoStores) stores[spec.dbId] = await mock.createStore(spec);
const { token, accessId } = await mock.createAccess('ERP Atelier', tier);
await mock.grant(accessId, stores[CLIENTS_DB]!, 'rw');
if (tier !== 'free') {
  await mock.grant(accessId, stores[COMMANDES_DB]!, 'rw');
  await mock.grant(accessId, stores[CATALOGUE_DB]!, 'r');
}

process.stdout.write(
  `Filarr en mémoire sur ${url} (palier ${tier}).\n\nJeton de l'accès « ERP Atelier » (montré une fois) :\n\n  ${token}\n\n` +
    `Boîte noire :\n  FILARR_GATE_API_URL=${url} FILARR_GATE_TOKEN=${token} npx filarr-gate\n\n` +
    `Un geste de l'application toutes les 20 s. Ctrl+C pour arrêter.\n`
);

const villes = ['Lyon', 'Nantes', 'Lille', 'Paris', 'Bordeaux', 'Rennes'];
let n = 0;
setInterval(() => {
  n += 1;
  const edit =
    n % 3 === 0
      ? [
          { r: `r_demo_${n}`, f: 'p_nom', v: `Client ${n}` },
          { r: `r_demo_${n}`, f: 'p_ville', v: villes[n % villes.length] },
          { r: `r_demo_${n}`, f: '#o', v: `z${n}` },
          { r: `r_demo_${n}`, f: '#c', v: new Date().toISOString() },
        ]
      : [{ r: 'r_acme', f: 'p_ca', v: 12500 + n * 100 }];
  void mock.appEdit(stores[CLIENTS_DB]!, edit).then((seq) => process.stdout.write(`geste de l'application : Clients v${seq}\n`));
}, 20_000).unref?.();

process.on('SIGINT', () => void mock.close().then(() => process.exit(0)));
setInterval(() => undefined, 1 << 30);
