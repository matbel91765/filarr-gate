/** La version de la boîte noire, posée au paquetage (`scripts/build-server.mjs`) ; en développement, celle de package.json. */

import { readFileSync } from 'node:fs';

declare const __GATE_VERSION__: string | undefined;

function fromPackage(): string {
  try {
    const url = new URL('../package.json', import.meta.url);
    return (JSON.parse(readFileSync(url, 'utf8')) as { version?: string }).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export const GATE_VERSION: string =
  typeof __GATE_VERSION__ === 'string' ? __GATE_VERSION__ : fromPackage();
