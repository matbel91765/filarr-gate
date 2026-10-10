/**
 * Ce que les paquets npm et l'image emportent : les licences tierces à jour, et des README dont les liens
 * mènent quelque part une fois sur npm.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { absolutizeLinks, blobBase } from '../scripts/prepack.mjs';
import { buildNotices, UI_BUNDLED } from '../scripts/third-party.mjs';

const repo = join(__dirname, '..');
const read = (...p: string[]) => readFileSync(join(repo, ...p), 'utf8').replace(/\r\n/g, '\n');
const cli = JSON.parse(read('packages', 'cli', 'package.json')) as { files: string[]; scripts: { prepack: string }; repository: { url: string } };

describe('licences tierces', () => {
  it('THIRD_PARTY_NOTICES est à jour (node scripts/third-party.mjs)', () => {
    expect(read('THIRD_PARTY_NOTICES')).toBe(buildNotices());
  });

  it('il couvre ce que l’interface embarque et ce que l’image installe', () => {
    const text = read('THIRD_PARTY_NOTICES');
    for (const name of [...UI_BUNDLED, '@noble/curves', '@noble/hashes', 'fflate', 'ws', 'pg', 'mysql2']) expect(text, name).toContain(`- ${name} `);
    // Les paquets que l'interface importe sont tous déclarés (ou des dépendances d'exécution déjà listées)
    const dir = join(repo, 'packages', 'cli', 'ui', 'src');
    const imports = new Set<string>();
    for (const f of readdirSync(dir, { recursive: true }) as string[]) {
      if (!/\.tsx?$/.test(f)) continue;
      for (const m of readFileSync(join(dir, f), 'utf8').matchAll(/from '((?:@[^/']+\/)?[^./'][^/']*)/g)) imports.add(m[1]!);
    }
    for (const name of imports) expect(text, name).toContain(`- ${name} `);
  });

  it('il part avec la commande, l’image, et NOTICE le nomme', () => {
    expect(cli.files).toContain('THIRD_PARTY_NOTICES');
    expect(cli.scripts.prepack).toContain('THIRD_PARTY_NOTICES');
    expect(read('Dockerfile')).toMatch(/^COPY .*THIRD_PARTY_NOTICES/m);
    expect(read('NOTICE')).toContain('THIRD_PARTY_NOTICES');
  });
});

describe('README des paquets npm', () => {
  const base = blobBase(cli.repository.url);

  it('les liens relatifs deviennent absolus vers le dépôt', () => {
    expect(base).toBe('https://github.com/filarr-work/filarr-gate/blob/main/');
    expect(absolutizeLinks('[a](docs/x.md#y) [b](https://e.test) [c](#ancre) ![d](./img.png) [e](mailto:x@example.test)', base)).toBe(
      `[a](${base}docs/x.md#y) [b](https://e.test) [c](#ancre) ![d](${base}img.png) [e](mailto:x@example.test)`
    );
  });

  it.each(['README.md', 'README.fr.md', 'SECURITY.md'])('%s, copié dans filarr-gate, n’a plus aucun lien relatif', (name) => {
    const out = absolutizeLinks(read(name), base);
    const relative = [...out.matchAll(/!?\[[^\]]*\]\(([^)\s]+)\)/g)].map((m) => m[1]!).filter((t) => !/^(https?:|mailto:|#)/.test(t));
    expect(relative).toEqual([]);
  });
});
