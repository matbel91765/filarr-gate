/**
 * Le cœur de Filarr Gate écrit son journal de console (`log.*` de `packages/server`) : dans le
 * service hébergé, il n'écrit RIEN (contrat `gate-heberge-1` § 10.3). Importé en premier par
 * `worker.ts`, avant toute boîte. Le journal propre de chaque boîte (celui de son écran
 * « Journal ») reste dans son état, chiffré sous `K_box`, lisible par le seul canal de gestion.
 */

import { setLogLevel, setLogWriter } from '../../server/src/log';

export function silenceCoreLog(): void {
  setLogWriter(() => undefined);
  setLogLevel('silent');
}

silenceCoreLog();
