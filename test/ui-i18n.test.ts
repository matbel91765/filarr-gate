/** Chaque texte de l'interface a sa traduction anglaise. */

import { describe, expect, it } from 'vitest';
// @ts-expect-error module JavaScript sans types
import { uiStrings } from '../packages/cli/scripts/i18n-strings.mjs';
import { EN } from '../packages/cli/ui/src/en';

describe('traductions de l’interface', () => {
  it('aucun texte français sans son anglais', () => {
    const missing = (uiStrings() as string[]).filter((k) => !(k in EN));
    expect(missing).toEqual([]);
  });

  it('les variables d’un texte se retrouvent dans sa traduction', () => {
    const vars = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
    const bad = Object.entries(EN).filter(([fr, en]) => vars(fr) !== vars(en)).map(([fr]) => fr);
    expect(bad).toEqual([]);
  });
});
