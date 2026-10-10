/**
 * Les vecteurs que le WORKER de Filarr écrit (filarg `test-vectors/`, copies identiques) et que
 * la boîte noire LIT sans les recalculer : les réveils poussés (`gate-heberge-1` famille 4 :
 * `A_notify`, en-tête, fenêtre de 300 s, refus) et le corps de chaque réveil
 * (`boite-noire-v2-serveur`, `wake` : le type et l'endroit, jamais le contenu).
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { notifyHeader, readNotifyBody, verifyNotify } from '../packages/core/src/engine/gate/access3';
import { storeCrypto } from '../packages/gate/src/crypto/providers';
import { openToken } from '../packages/gate/src/replica/token';

const dir = join(__dirname, 'vectors');
const read = <T>(name: string): T => JSON.parse(readFileSync(join(dir, name), 'utf8')) as T;
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

interface NotifyVectors {
  notify: {
    token: string;
    accessId: string;
    aNotify: string;
    body: string;
    t: number;
    header: string;
    accepted: Array<{ now: number }>;
    refused: Array<{ why: string; now: number; body: string; header: string }>;
  };
}

interface WakeVectors {
  wake: { cases: Array<{ message: Record<string, unknown>; body: Record<string, unknown> }> };
}

describe('gate-heberge-1, famille 4 : les réveils poussés (écrits par le worker)', () => {
  const v = read<NotifyVectors>('gate-heberge-1.vectors.json').notify;

  it('A_notify tirée du jeton, et le même en-tête', async () => {
    const identity = await openToken(v.token);
    expect(identity.accessId).toBe(v.accessId);
    expect(hex(identity.aNotify)).toBe(v.aNotify);
    expect(await notifyHeader(storeCrypto, identity.aNotify, v.body, v.t)).toBe(v.header);
  });

  it('acceptés dans la fenêtre, refusés hors d’elle, corps altéré ou autre clé', async () => {
    const { aNotify } = await openToken(v.token);
    for (const a of v.accepted) expect(await verifyNotify(storeCrypto, aNotify, v.header, v.body, a.now), String(a.now)).toBe('ok');
    for (const r of v.refused) expect(await verifyNotify(storeCrypto, aNotify, r.header, r.body, r.now), r.why).not.toBe('ok');
  });
});

describe('boite-noire-v2-serveur, wake : le corps de chaque réveil', () => {
  const v = read<WakeVectors>('boite-noire-v2-serveur.vectors.json').wake;

  it.each(v.cases.map((c) => [c.message.t, c] as const))('%s : lu tel que le worker l’envoie, rien de plus', (_t, c) => {
    const raw = JSON.stringify({ ...c.body, at: '2026-10-10T00:00:00.000Z' });
    const body = readNotifyBody(raw, String(c.body.a));
    expect(body).toEqual({ ...c.body, at: '2026-10-10T00:00:00.000Z' });
    // Le réveil d'un autre accès n'est pas lu
    expect(readNotifyBody(raw, 'AUTRE')).toBeNull();
  });
});
