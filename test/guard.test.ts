/**
 * LA GARDE DES ESSAIS (`support/noProduction.cjs`) : aucune connexion vers la production, par
 * aucun chemin — `fetch`, sockets (`https`, `ws`, `net`), résolution des noms, processus enfants
 * (qui la rechargent par `NODE_OPTIONS`), `wrangler dev`.
 *
 * Les chemins réseau sont éprouvés contre `garde-production.invalid`, interdit comme filarr.com :
 * `.invalid` ne se résout jamais, donc une garde cassée ne ferait rien partir vers Filarr pendant
 * qu'on la vérifie. Le domaine de production lui-même n'est éprouvé que par le prédicat, et par
 * les refus SYNCHRONES (rien n'est lancé).
 */

import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { lookup } from 'node:dns';
import { writeFileSync } from 'node:fs';
import { get as httpsGet } from 'node:https';
import { connect, Socket } from 'node:net';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import WebSocket from 'ws';
import { describe, expect, it } from 'vitest';
import { Gate } from '../packages/cli/src/gate';
import { runDoctor } from '../packages/server/src/doctor';
import { tempDir } from './support/util';

const guard = createRequire(import.meta.url)('./support/noProduction.cjs') as {
  isForbiddenHost: (h: string) => boolean;
  forbiddenUrlIn: (s: string) => string | null;
  SAFE_API_URL: string;
};
const TRAP = 'https://api.garde-production.invalid/public/api-limits';

const errorOf = (start: (done: (err: unknown) => void) => void): Promise<{ code?: string; message: string }> =>
  new Promise((resolve) => start((err) => resolve(err as { code?: string; message: string })));

describe('la garde des essais : aucune connexion vers la production', () => {
  it('le prédicat : filarr.com et ses sous-domaines (casse, point final), rien d’autre', () => {
    for (const h of ['filarr.com', 'api.filarr.com', 'API.Filarr.COM.', 'send.filarr.com', 'x.garde-production.invalid']) expect(guard.isForbiddenHost(h), h).toBe(true);
    for (const h of ['notfilarr.com', 'filarr.com.example.org', '127.0.0.1', 'localhost', 'api.cloudflare.com', '']) expect(guard.isForbiddenHost(h), h).toBe(false);
    expect(guard.forbiddenUrlIn('--var FILARR_GATE_API_URL:https://api.filarr.com')).toBe('https://api.filarr.com');
    expect(guard.forbiddenUrlIn('wss://api.filarr.com/api-access/self/stream')).toBe('wss://api.filarr.com');
    expect(guard.forbiddenUrlIn('http://127.0.0.1:8806')).toBeNull();
  });

  it('posée partout dans ce processus : fetch, sockets, et les `import` de node:child_process', () => {
    expect(globalThis.fetch.name).toBe('guardedFetch');
    expect(Socket.prototype.connect.name).toBe('guardedConnect');
    expect(spawn.name).toBe('guardedFile');
    expect(process.env.FILARR_GATE_API_URL).toBeTruthy();
    expect(guard.isForbiddenHost(new URL(process.env.FILARR_GATE_API_URL!).hostname)).toBe(false);
  });

  it('fetch, https, ws, net et dns refusent un hôte interdit, avant tout octet', async () => {
    await expect(fetch(TRAP)).rejects.toMatchObject({ code: 'E_FILARR_PRODUCTION' });
    expect(await errorOf((done) => httpsGet(TRAP).on('error', done))).toMatchObject({ code: 'E_FILARR_PRODUCTION' });
    expect(await errorOf((done) => new WebSocket('wss://api.garde-production.invalid/api-access/self/stream').on('error', done))).toMatchObject({ code: 'E_FILARR_PRODUCTION' });
    expect(await errorOf((done) => connect({ host: 'db.garde-production.invalid', port: 5432 }).on('error', done))).toMatchObject({ code: 'E_FILARR_PRODUCTION' });
    expect(await errorOf((done) => connect(443, 'garde-production.invalid').on('error', done))).toMatchObject({ code: 'E_FILARR_PRODUCTION' });
    expect(await errorOf((done) => lookup('api.garde-production.invalid', done))).toMatchObject({ code: 'E_FILARR_PRODUCTION' });
  });

  it('le diagnostic de la boîte (le GET non authentifié de l’incident) passe par la garde', async () => {
    const gate = new Gate({ env: { FILARR_GATE_STATE_DIR: tempDir(), FILARR_GATE_API_URL: 'https://api.garde-production.invalid', FILARR_GATE_CACHE: 'memory' }, listen: false });
    const checks = await runDoctor(gate);
    expect(checks.find((c) => c.name === 'filarr')).toMatchObject({ result: 'fail', detail: expect.stringContaining('production refusée') });
  });

  it('un processus Node enfant recharge la garde, et reçoit une adresse morte à la place du défaut de production', () => {
    const script = [
      "fetch('https://api.garde-production.invalid/x').then(() => console.log('PARTI'), (e) => console.log('REFUS', e.code));",
      "require('node:https').get('https://api.garde-production.invalid/x').on('error', (e) => console.log('REFUS', e.code));",
      'console.log(process.env.FILARR_GATE_API_URL);',
    ].join('\n');
    // Le script dans un fichier : la garde du parent refuserait déjà une adresse interdite en argument
    const file = join(tempDir(), 'enfant.cjs');
    writeFileSync(file, script);
    const out = spawnSync(process.execPath, [file], { encoding: 'utf8', env: { ...process.env, FILARR_GATE_API_URL: '' } });
    expect(out.stdout).toContain(guard.SAFE_API_URL);
    expect(out.stdout.match(/REFUS E_FILARR_PRODUCTION/g)).toHaveLength(2);
    expect(out.stdout).not.toContain('PARTI');
  });

  it('refus SYNCHRONES : adresse de production dans les arguments ou l’environnement d’un enfant ; wrangler dev sans adresse locale ; wrangler deploy', () => {
    // Rien n'est lancé : la garde lève avant (un chemin inexistant, au cas où elle ne lèverait pas)
    const absent = 'C:/garde-nexiste-pas/script.js';
    expect(() => spawn(process.execPath, [absent], { env: { ...process.env, FILARR_GATE_API_URL: 'https://api.filarr.com' } })).toThrow(/production refusée/);
    expect(() => execFileSync(process.execPath, [absent, '--api-url', 'https://api.filarr.com'])).toThrow(/production refusée/);
    const wrangler = 'C:/garde-nexiste-pas/wrangler/bin/wrangler.js';
    expect(() => spawn(process.execPath, [wrangler, 'dev', '--local', '--port', '1'])).toThrow(/wrangler dev sans --var FILARR_GATE_API_URL/);
    expect(() => spawn(process.execPath, [wrangler, 'dev', '--var', 'FILARR_GATE_API_URL:http://10.0.0.5:8787'])).toThrow(/boucle locale seulement/);
    expect(() => spawn(process.execPath, [wrangler, 'dev', '--var', 'FILARR_GATE_API_URL:https://api.filarr.com'])).toThrow(/production refusée/);
    expect(() => spawn(process.execPath, [wrangler, 'deploy'])).toThrow(/wrangler contre Cloudflare/);
    expect(() => spawn(process.execPath, [wrangler, 'd1', 'execute', 'filarr-auth', '--remote'])).toThrow(/wrangler contre Cloudflare/);
  });
});
