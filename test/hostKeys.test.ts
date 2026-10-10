/**
 * `scripts/host-keys.mjs` (contrat gate-heberge-1 § 2.0.5), SANS jamais parler à Cloudflare : la pose des
 * secrets est remplacée par un témoin. On vérifie que les clés privées ne vont QUE dans l'entrée standard de
 * `wrangler secret put` (ni à l'écran, ni dans un fichier), que l'entrée publique est juste, et que le service
 * les accepte (son trousseau les rapproche de l'entrée épinglée). Lancé pour de vrai dans les essais, le script
 * est arrêté par la garde des essais avant d'avoir rien tiré ni écrit.
 */

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { generateHostKeys, main } from '../scripts/host-keys.mjs';
import { loadKeyring, readPinned } from '../packages/host/src/keys';

const keysFile = (content = '[]\n') => {
  const f = join(mkdtempSync(join(tmpdir(), 'host-keys-')), 'hosted-keys.json');
  writeFileSync(f, content);
  return f;
};

describe('scripts/host-keys.mjs', () => {
  it('la première paire : secrets HOST_ENC et HOST_SIG par l’entrée standard, entrée publique au fichier, rien de privé à l’écran', async () => {
    const file = keysFile();
    const put: Array<{ name: string; value: string }> = [];
    const out: string[] = [];
    const now = Date.parse('2026-10-11T08:00:00.000Z');
    const { entry, names } = await main([], { keysFile: file, now, putSecret: async (name, value) => void put.push({ name, value }), log: (l) => out.push(l) });
    expect(names).toEqual({ enc: 'HOST_ENC', sig: 'HOST_SIG' });
    expect(put.map((p) => p.name)).toEqual(['HOST_ENC', 'HOST_SIG']);
    expect(entry).toMatchObject({ id: 'h1', notBefore: '2026-10-11T08:00:00.000Z', notAfter: '2028-10-10T08:00:00.000Z' });
    const written = JSON.parse(readFileSync(file, 'utf8'));
    expect(written).toEqual([entry]);
    expect(readPinned(written)).toEqual([entry]);
    // Les clés privées : seulement dans ce qui part vers wrangler
    const privates = put.map((p) => (JSON.parse(p.value) as { privateKey: string }).privateKey);
    for (const priv of privates) {
      expect(Buffer.from(priv, 'base64')).toHaveLength(32);
      expect(out.join('\n')).not.toContain(priv);
      expect(readFileSync(file, 'utf8')).not.toContain(priv);
    }
    expect(out.join('\n')).toContain(entry.encPublicKey);
    expect(out.join('\n')).toContain(entry.signPublicKey);
    // Le service rapproche les secrets de l'entrée épinglée : il les garde
    const ring = loadKeyring({ HOST_ENC: put[0]!.value, HOST_SIG: put[1]!.value }, written);
    expect([...ring.enc.keys()]).toEqual(['h1']);
    expect([...ring.sig.keys()]).toEqual(['h1']);
  });

  it('une rotation : HOST_ENC_<id> et HOST_SIG_<id>, au moins 60 jours d’avance ; refus d’un identifiant pris', async () => {
    const first = generateHostKeys({ id: 'h1', notBefore: '2026-10-11T00:00:00.000Z', notAfter: '2028-10-11T00:00:00.000Z' }).entry;
    const file = keysFile(`${JSON.stringify([first])}\n`);
    const now = Date.parse('2027-06-01T00:00:00.000Z');
    const put: string[] = [];
    const io = { keysFile: file, now, putSecret: async (name: string) => void put.push(name), log: () => undefined };
    await expect(main([], io)).rejects.toThrow(/--rotate/);
    await expect(main(['--rotate', '--id', 'h2', '--not-before', '2027-06-20T00:00:00.000Z'], io)).rejects.toThrow(/60 jours/);
    await expect(main(['--rotate', '--id', 'h1', '--not-before', '2027-09-01T00:00:00.000Z'], io)).rejects.toThrow(/existe déjà/);
    expect(put).toEqual([]);
    const { names } = await main(['--rotate', '--id', 'h2', '--not-before', '2027-09-01T00:00:00.000Z'], io);
    expect(names).toEqual({ enc: 'HOST_ENC_h2', sig: 'HOST_SIG_h2' });
    expect((JSON.parse(readFileSync(file, 'utf8')) as Array<{ id: string }>).map((k) => k.id)).toEqual(['h1', 'h2']);
  });

  it('un secret qui ne passe pas : rien n’est écrit au fichier', async () => {
    const file = keysFile();
    await expect(main([], { keysFile: file, putSecret: async () => Promise.reject(new Error('refusé')), log: () => undefined })).rejects.toThrow('refusé');
    expect(readFileSync(file, 'utf8')).toBe('[]\n');
  });

  it('lancé pour de vrai dans les essais : la garde arrête wrangler secret put, le fichier ne bouge pas', async () => {
    const file = keysFile();
    await expect(main([], { keysFile: file, log: () => undefined })).rejects.toThrow(/wrangler contre Cloudflare/);
    expect(readFileSync(file, 'utf8')).toBe('[]\n');
  });

  it('docs/hosted-keys.json, publié par le dépôt, est une liste d’entrées publiques valides', () => {
    const list = JSON.parse(readFileSync(join(__dirname, '..', 'docs', 'hosted-keys.json'), 'utf8'));
    expect(Array.isArray(list)).toBe(true);
    expect(readPinned(list)).toEqual(list);
    for (const k of list as Array<Record<string, unknown>>) expect(Object.keys(k).sort()).toEqual(['encPublicKey', 'id', 'notAfter', 'notBefore', 'signPublicKey']);
  });
});
