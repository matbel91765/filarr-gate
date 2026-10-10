/**
 * Garde des essais : aucune requête ne part vers les serveurs de Filarr (production).
 * Tout essai parle au Filarr en mémoire, ou au worker local du banc.
 *
 * La garde vit dans `noProduction.cjs` (CommonJS, pour que les processus Node ENFANTS la chargent
 * aussi, par `NODE_OPTIONS=--require`) : `fetch`, chaque socket TCP ou TLS, la résolution des noms,
 * les processus enfants et `wrangler dev`. Voir son en-tête ; `test/guard.test.ts` la vérifie.
 */

import { createRequire } from 'node:module';

createRequire(import.meta.url)('./noProduction.cjs');
