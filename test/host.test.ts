/**
 * LE SERVICE HÉBERGÉ, DE BOUT EN BOUT, EN MÉMOIRE (contrat gate-heberge-1 § 2 à § 9) : le Worker de
 * devant, l'annuaire et les boîtes (`packages/host`) sur des stockages d'objets durables en mémoire,
 * contre le Filarr en mémoire qui joue l'API principale (routes signées du service, réveils vers
 * l'adresse de contrôle, refus d'un jeton hébergé sans la signature du service).
 *
 * Le même code tourne sous workerd dans `test/host.e2e.test.ts` (le module construit, sous wrangler dev).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { notifyHeader, deriveAccessKeys3 } from '../packages/core/src/engine/gate/access3';
import { openSettings } from '../packages/core/src/engine/gate/settings';
import { parseAccessToken, toBase64Std } from '../packages/core/src/engine/store/apiAccess';
import { toBase64Url, utf8Encode } from '../packages/core/src/engine/store/crypto';
import { curves, storeCrypto } from '../packages/gate/src/crypto/providers';
import { openToken } from '../packages/gate/src/replica/token';
import { sha256Hex } from '../packages/gate/src/util/bytes';
import { Directory } from '../packages/host/src/directory';
import { HOST_VERSION } from '../packages/host/src/env';
import { HostApi } from '../packages/host/src/hostApi';
import { loadKeyring, signingKey } from '../packages/host/src/keys';
import { announcement } from '../packages/host/src/version';
import { erasureReason } from '../packages/host/src/box';
import { adminMessage, bodyHashHex, ERASED_ALL, receiptMessage, signReceipt, verifyHostSignature, versionMessage, type ErasureReceipt } from '../packages/host/src/wire';
import { CLIENTS_DB, COMMANDES_DB, demoStores } from './support/demoData';
import { HostHarness, MemoryDoStorage, TEST_DOMAIN } from './support/hostHarness';
import { MockFilarr } from './support/mockFilarr';
import { until } from './support/util';

const CTL = `https://ctl.${TEST_DOMAIN}`;
const FIRST_KEY = `gk_live_${toBase64Url(new Uint8Array(24).fill(7))}`;

let mock: MockFilarr;
let h: HostHarness;
let clients = '';
let commandes = '';
let token = '';
let accessId = '';
const hostName = 'site-vitrine-7qm2';
const box = (path: string) => `https://${hostName}.${TEST_DOMAIN}${path}`;
const bearer = (key: string) => ({ headers: { Authorization: `Bearer ${key}` } });

/** Un réveil de l'API, signé sous `A_notify` (clé de l'accès), envoyé à l'adresse de contrôle (PH8). */
async function wake(tok: string, body: Record<string, unknown>, opts: { at?: number; forge?: boolean } = {}): Promise<Response> {
  const parsed = parseAccessToken(tok)!;
  const { aNotify } = await deriveAccessKeys3(storeCrypto, parsed.accessIdBytes, parsed.secret);
  const raw = JSON.stringify({ a: parsed.accessId, ...body, at: new Date().toISOString() });
  const t = Math.floor((opts.at ?? Date.now()) / 1000);
  const header = opts.forge ? `t=${t},v1=${'0'.repeat(64)}` : await notifyHeader(storeCrypto, aNotify, raw, t);
  return h.fetch(`${CTL}/_filarr/notify/${parsed.accessId}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Filarr-Notify': header }, body: raw });
}

/** Une requête du canal de gestion, signée par la clé d'identité du créateur (§ 7.2). */
async function admin(method: string, path: string, body?: unknown, opts: { key?: Uint8Array; t?: number; header?: string | null } = {}): Promise<Response> {
  const text = body === undefined ? '' : JSON.stringify(body);
  const t = opts.t ?? Math.floor(Date.now() / 1000);
  const message = adminMessage(method, path, t, bodyHashHex(text));
  const s = toBase64Url(curves.ed25519Sign(opts.key ?? mock.creatorSigningKey, utf8Encode(message)));
  const headers: Record<string, string> = { 'Content-Type': 'application/json', Origin: 'https://app.filarr.com' };
  if (opts.header !== null) headers['Filarr-Creator'] = opts.header ?? `t=${t},s=${s}`;
  return h.fetch(box(path), { method, headers, ...(text ? { body: text } : {}) });
}

const rowsOf = async (res: Response) => ((await res.json()) as { rows: Array<Record<string, unknown>> }).rows;

beforeAll(async () => {
  mock = new MockFilarr({ writeSwitch: true });
  await mock.listen();
  clients = await mock.createStore(demoStores.find((s) => s.dbId === CLIENTS_DB)!);
  commandes = await mock.createStore(demoStores.find((s) => s.dbId === COMMANDES_DB)!);
  h = new HostHarness(mock.url);
  h.timing = { usageEveryMs: 0 };
  mock.hostKeys = [h.key.pinned];
  mock.hostWakeFetch = h.wakeFetch;
}, 60_000);

afterAll(async () => {
  await h?.dispose();
  await mock?.close();
});

describe('service hébergé, en mémoire', () => {
  it('création : rien ne répond avant le premier réveil vérifié ; le réveil ouvre le jeton scellé et range le nom', async () => {
    const created = await mock.createHostedAccess('Site vitrine', {
      hostName,
      key: h.key.pinned,
      // Le paquet initial `s` : l'empreinte de la première clé d'application, tirée par l'appareil (§ 6.1)
      settings: (id) => ({ v: 1, kind: 'filarr-gate/settings', accessId: id, appKeys: [{ id: 'k-premiere', name: 'Première clé', hash: sha256Hex(FIRST_KEY), scopes: [{ target: 'all', read: true }] }] }),
    });
    accessId = created.accessId;
    token = created.token;
    await mock.grant(accessId, clients, 'rw');
    await mock.grant(accessId, commandes, 'r');
    expect((await h.fetch(box('/health'))).status).toBe(404);
    // L'adresse de contrôle est posée : les réveils de l'API y arrivent désormais
    mock.hostControlUrl = CTL;
    // Le premier réveil, que l'API envoie juste après la création (PH8)
    expect((await wake(token, { t: 'hosting', state: 'running' })).status).toBe(202);
    await h.settle();
    await until(async () => ((await (await h.fetch(box('/health'))).json()) as { status: string }).status === 'ok', 15_000, 'boîte prête');
    const health = (await (await h.fetch(box('/health'))).json()) as Record<string, unknown>;
    expect(health).toMatchObject({ status: 'ok', version: HOST_VERSION });
    // /health d'une boîte hébergée ne nomme aucune base
    expect(JSON.stringify(health)).not.toContain('clients');
  }, 30_000);

  it('la première clé d’application (empreinte du jeton scellé) sert l’API ; tout appel à l’API est signé par le service', async () => {
    const res = await h.fetch(box('/v1/clients?limit=10'), bearer(FIRST_KEY));
    expect(res.status, await res.clone().text()).toBe(200);
    expect((await rowsOf(res)).map((r) => r.nom)).toContain('Acme');
    expect(mock.hostChecks.length).toBeGreaterThan(3);
    expect(mock.hostChecks.every((c) => c.ok)).toBe(true);
    expect(mock.requests.filter((r) => r.code === 'hosted_origin_required')).toEqual([]);
    // Le jeton hébergé, présenté sans la signature du service, est refusé (défense en profondeur, § 2.2)
    const identity = await openToken(token);
    const direct = await fetch(`${mock.url}/api-access/self`, { headers: { Authorization: identity.authorization, 'X-Filarr-Sync-Caps': 'db-store-1, api-base-1' } });
    expect(direct.status).toBe(401);
    expect(((await direct.json()) as { code: string }).code).toBe('hosted_origin_required');
  });

  it('au repos, tout l’état est chiffré sous K_box : aucune ligne, aucune empreinte de clé, aucun jeton en clair', async () => {
    const storage = h.storages.get(accessId)!;
    const needles = ['Acme', sha256Hex(FIRST_KEY), token, 'Première clé'];
    let sealedEntries = 0;
    for (const [key, value] of storage.data) {
      const text = value instanceof Uint8Array ? Buffer.from(value).toString('latin1') : JSON.stringify(value);
      for (const n of needles) expect(text.includes(n), `${key} contient ${n.slice(0, 12)}`).toBe(false);
      if (key.startsWith('host:')) continue;
      expect(value instanceof Uint8Array, key).toBe(true);
      sealedEntries += 1;
    }
    expect(sealedEntries).toBeGreaterThan(3);
    expect([...storage.data.keys()].filter((k) => k.startsWith('host:'))).toEqual(['host:meta']);
  });

  it('réveils : signé et récent seulement ; un geste dans l’appli arrive par le réveil', async () => {
    expect((await wake(token, { t: 'commit' }, { forge: true })).status).toBe(401);
    expect((await wake(token, { t: 'commit' }, { at: Date.now() - 400_000 })).status).toBe(401);
    await mock.appEdit(clients, [{ r: 'r_globex', f: 'p_ville', v: 'Brest' }]);
    await h.settle();
    await until(async () => {
      const row = (await (await h.fetch(box('/v1/clients/rows/r_globex'), bearer(FIRST_KEY))).json()) as { row?: { ville?: string } };
      return row.row?.ville === 'Brest';
    }, 15_000, 'réveil appliqué');
    expect(mock.notifications.some((n) => n.url === `${CTL}/_filarr/notify/${accessId}` && n.status === 202 && JSON.parse(n.body).t === 'commit')).toBe(true);
  }, 30_000);

  let erpKey = '';
  it('canal de gestion : signé par la clé du créateur, une fois ; routes du jeton et du mot de passe fermées ; CORS du web', async () => {
    const created = await admin('POST', '/_admin/keys', { name: 'erp', scopes: [{ target: 'all' }, { target: 'base', storeId: clients, read: true, create: true, update: true, delete: false }] });
    expect(created.status, await created.clone().text()).toBe(201);
    expect(created.headers.get('access-control-allow-origin')).toBe('https://app.filarr.com');
    expect(created.headers.get('set-cookie')).toBeNull();
    erpKey = ((await created.json()) as { key: string }).key;
    expect((await admin('PUT', '/_admin/settings', { write: true })).status).toBe(200);
    const write = await h.fetch(box('/v1/clients'), { method: 'POST', headers: { Authorization: `Bearer ${erpKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ nom: 'Hooli', ville: 'Rennes' }) });
    expect(write.status, await write.clone().text()).toBe(201);
    await until(async () => (await mock.appRows(clients)).some((r) => JSON.stringify(r).includes('Hooli')), 15_000, 'écriture reçue par Filarr');

    // Rejeu, sans signature, mauvaise clé, horloge, route fermée
    const t = Math.floor(Date.now() / 1000);
    expect((await admin('GET', '/_admin/keys', undefined, { t })).status).toBe(200);
    const replay = await admin('GET', '/_admin/keys', undefined, { t });
    expect(replay.status).toBe(401);
    expect(((await replay.json()) as { code: string }).code).toBe('replay');
    expect(((await (await admin('GET', '/_admin/keys', undefined, { header: null })).json()) as { code: string }).code).toBe('admin_missing');
    expect(((await (await admin('GET', '/_admin/keys', undefined, { key: new Uint8Array(32).fill(3) })).json()) as { code: string }).code).toBe('admin_signature');
    expect(((await (await admin('GET', '/_admin/keys', undefined, { t: t - 600 })).json()) as { code: string }).code).toBe('admin_clock');
    // PH11 : la chaîne signée porte le chemin AVEC sa requête
    expect((await admin('GET', '/_admin/journal?limit=5')).status).toBe(200);
    const tq = Math.floor(Date.now() / 1000) - 1;
    const noQuery = toBase64Url(curves.ed25519Sign(mock.creatorSigningKey, utf8Encode(adminMessage('GET', '/_admin/journal', tq, bodyHashHex('')))));
    const cut = await h.fetch(box('/_admin/journal?limit=5'), { headers: { 'Filarr-Creator': `t=${tq},s=${noQuery}` } });
    expect(((await cut.json()) as { code: string }).code).toBe('admin_signature');
    for (const path of ['/_admin/token', '/_admin/password', '/_admin/forget', '/_admin/export', '/_admin/setup/token']) {
      const res = await admin('POST', path, {});
      expect(res.status, path).toBe(403);
    }
    // Aucune interface web, aucune métrique, aucun réveil sur l'adresse d'une boîte
    for (const path of ['/admin/', '/admin/api/state', '/metrics', '/_filarr/notify']) expect((await h.fetch(box(path))).status, path).toBe(404);
    const pre = await h.fetch(box('/_admin/keys'), { method: 'OPTIONS', headers: { Origin: 'app://filarr', 'Access-Control-Request-Method': 'POST' } });
    expect(pre.status).toBe(204);
    expect(pre.headers.get('access-control-allow-origin')).toBe('app://filarr');
    const evil = await h.fetch(box('/_admin/keys'), { method: 'OPTIONS', headers: { Origin: 'https://evil.example.test' } });
    expect(evil.headers.get('access-control-allow-origin')).toBeNull();
  }, 30_000);

  it('appels du mois : 429 hosted_quota_calls au-delà du barème, Retry-After jusqu’au 1er ; le total est remis à l’API', async () => {
    const used = (await h.box(accessId).status()).meta!.calls.n;
    mock.hostedCallsPerMonth = used + 2;
    await mock.grant(accessId, clients, 'rw'); // relit `self` (et ses limites) par le réveil
    await h.settle();
    await until(async () => (await h.box(accessId).status()).meta!.calls.n >= used, 5000, 'compte relu');
    const results: number[] = [];
    for (let i = 0; i < 4; i += 1) results.push((await h.fetch(box('/v1/clients?limit=1'), bearer(erpKey))).status);
    expect(results.slice(-1)[0]).toBe(429);
    const refused = await h.fetch(box('/v1/clients?limit=1'), bearer(erpKey));
    const body = (await refused.json()) as { code: string; remedy: string[] };
    expect(body).toMatchObject({ code: 'hosted_quota_calls', remedy: ['wait'] });
    const firstOfNextMonth = Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() + 1, 1);
    expect(Math.abs(Number(refused.headers.get('retry-after')) - (firstOfNextMonth - Date.now()) / 1000)).toBeLessThan(5);
    mock.hostedCallsPerMonth = null;
    await mock.grant(accessId, clients, 'rw');
    await h.settle();
    await h.box(accessId).alarm();
    const last = mock.hostedUsage.filter((u) => u.accessId === accessId).at(-1)!;
    expect(last.period).toBe(new Date().toISOString().slice(0, 7));
    expect(last.calls).toBe((await h.box(accessId).status()).meta!.calls.n);
  }, 30_000);

  it('une base retirée de la boîte : sa copie est effacée, reçu PARTIEL signé (withdrawn)', async () => {
    mock.withdrawStore(accessId, commandes);
    await h.settle();
    await until(() => mock.hostedReceipts.some((r) => r.partial), 10_000, 'reçu partiel');
    const r = mock.hostedReceipts.find((x) => x.partial)!;
    expect(r.receipt).toMatchObject({ v: 1, kind: 'filarr-gate-host/erasure', accessId, hostName, reason: 'withdrawn', stores: [{ storeId: commandes, g: 0 }], erased: ['dbKeys', 'copy'], version: HOST_VERSION });
    expect(verifyHostSignature(receiptMessage(r.receipt), r.sig, Buffer.from(h.key.pinned.signPublicKey, 'base64'))).toBe(true);
    expect((await h.fetch(box('/v1/commandes?limit=1'), bearer(FIRST_KEY))).status).toBe(404);
    expect((await h.box(accessId).status()).meta!.stores.map((s) => s.storeId)).toEqual([clients]);
  }, 20_000);

  it('sommeil (impayé) : 503 gate_asleep, mémoire vidée, état chiffré gardé ; reprendre chez soi reste possible ; réveil au paiement', async () => {
    mock.hostingSleep(accessId, 'billing');
    await h.settle();
    await until(async () => (await h.box(accessId).status()).meta!.state === 'asleep', 10_000, 'endormie');
    expect((await h.box(accessId).status()).open).toBe(false);
    const asleep = await h.fetch(box('/v1/clients?limit=1'), bearer(erpKey));
    expect(asleep.status).toBe(503);
    expect(await asleep.json()).toMatchObject({ code: 'gate_asleep', reason: 'billing', remedy: ['updatePayment'] });
    expect(((await (await h.fetch(box('/health'))).json()) as { status: string }).status).toBe('asleep');
    expect([...h.storages.get(accessId)!.data.keys()].some((k) => k.startsWith('state'))).toBe(true);

    // « Reprendre chez moi » pendant le sommeil : le paquet de réglages, scellé vers l'identité en attente
    const newToken = await mock.migrateToSelf(accessId);
    await h.settle();
    await until(() => mock.accesses.get(accessId)!.pending!.exportSealed !== null, 10_000, 'paquet déposé');
    const target = await openToken(newToken);
    const pkg = await openSettings(storeCrypto, curves, target.aEnc, mock.accesses.get(accessId)!.pending!.exportSealed!, accessId);
    expect(pkg.appKeys.map((k) => k.hash).sort()).toEqual([sha256Hex(FIRST_KEY), sha256Hex(erpKey)].sort());
    expect(JSON.stringify(pkg)).not.toContain('password');
    expect((await h.box(accessId).status()).open).toBe(false);
    mock.accesses.get(accessId)!.pending = null;

    mock.hostingWake(accessId);
    await h.settle();
    await until(async () => (await h.fetch(box('/v1/clients?limit=1'), bearer(erpKey))).status === 200, 15_000, 'réveillée, clés relues');
  }, 40_000);

  it('arrêt d’urgence (GATE_HOSTED_KILL) : la boîte répond gate_asleep, raison « service »', async () => {
    await h.box(accessId).dispose();
    mock.hostedKill = true;
    await until(async () => {
      const res = await h.fetch(box('/v1/clients?limit=1'), bearer(erpKey));
      return res.status === 503 && ((await res.json()) as { reason?: string }).reason === 'service';
    }, 15_000, 'arrêt d’urgence');
    mock.hostedKill = false;
    await h.box(accessId).dispose();
  }, 30_000);

  it('annonce de version : signée, servie sur le contrôle et sur la boîte, remise une seule fois à l’API', async () => {
    expect((await h.fetch(`${CTL}/.well-known/filarr-gate-host.json`)).status).toBe(503);
    Object.assign(h.env, { HOST_CODE_HASH: `sha256:${'ab'.repeat(32)}`, HOST_BUILD_REF: 'v0.2.1', HOST_DEPLOYED_AT: '2026-10-17T08:00:00.000Z' });
    for (const url of [`${CTL}/.well-known/filarr-gate-host.json`, box('/.well-known/filarr-gate-host.json')]) {
      const res = await h.fetch(url);
      expect(res.status).toBe(200);
      const a = (await res.json()) as Record<string, unknown>;
      const { sig, ...rest } = a;
      expect(rest).toEqual({ version: HOST_VERSION, codeHash: `sha256:${'ab'.repeat(32)}`, buildRef: 'v0.2.1', deployedAt: '2026-10-17T08:00:00.000Z', keyId: h.key.pinned.id });
      expect(verifyHostSignature(versionMessage(rest), sig as string, Buffer.from(h.key.pinned.signPublicKey, 'base64'))).toBe(true);
    }
    const ring = loadKeyring(h.env, [h.key.pinned]);
    const api = new HostApi(mock.url, () => signingKey(ring, Date.now()), 'essai');
    const dir = new Directory(new MemoryDoStorage(), async (a) => void (await api.version(a)));
    const a = announcement(h.env, ring, Date.now())!;
    expect(await dir.announceOnce(a)).toBe('sent');
    expect(await dir.announceOnce(a)).toBe('already');
    expect(mock.hostedVersions).toHaveLength(1);
    // Un correctif de sécurité le dit dans l'annonce (§ 10.1, point 5)
    const sec = announcement({ ...h.env, HOST_SECURITY_ADVISORY: 'GHSA-2345-6789-cfgh' }, ring, Date.now())!;
    expect(sec).toMatchObject({ security: true, advisory: 'GHSA-2345-6789-cfgh' });
  });

  it('révocation : tout le stockage effacé, reçu signé remis, l’adresse ne répond plus', async () => {
    mock.hostingErase(accessId, { reason: 'revoked' });
    await h.settle();
    await until(() => mock.hostedReceipts.some((r) => !r.partial && r.accessId === accessId), 15_000, 'reçu d’effacement');
    const r = mock.hostedReceipts.find((x) => !x.partial && x.accessId === accessId)!;
    expect(r.receipt).toMatchObject({ reason: 'revoked', stores: [{ storeId: clients, g: 0 }], erased: [...ERASED_ALL], hostName, codeHash: `sha256:${'ab'.repeat(32)}` });
    // PH9 : l'heure de la demande est celle que l'API donne, telle quelle
    expect(r.receipt.requestedAt).toBe(mock.accesses.get(accessId)!.hosting!.eraseRequestedAt);
    expect(Date.parse(r.receipt.erasedAt as string)).toBeGreaterThanOrEqual(Date.parse(r.receipt.requestedAt as string));
    expect(mock.accesses.get(accessId)!.hosting!.state).toBe('erased');
    const storage = h.storages.get(accessId)!;
    expect([...storage.data.keys()]).toEqual(['host:meta']);
    expect((storage.data.get('host:meta') as { state: string; receipts: unknown[] }).state).toBe('erased');
    expect((storage.data.get('host:meta') as { receipts: unknown[] }).receipts).toEqual([]);
    expect(storage.alarm).toBeNull();
    expect((await h.fetch(box('/v1/clients?limit=1'), bearer(erpKey))).status).toBe(404);
  }, 30_000);

  it('sommeil échu (palier) : reçu « tier » ; migration basculée avec redirection : 308 pendant 30 jours', async () => {
    const two = await mock.createHostedAccess('Deux', { hostName: 'deux-ab12', key: h.key.pinned });
    await mock.grant(two.accessId, clients, 'r');
    await h.settle();
    await until(async () => (await h.fetch(`https://deux-ab12.${TEST_DOMAIN}/health`)).status === 200, 15_000, 'deux prête');
    mock.hostingSleep(two.accessId, 'tier');
    await h.settle();
    // Une API d'avant (sans eraseReason) : le service déduit la raison du sommeil
    mock.hostingErase(two.accessId, { legacy: true });
    await h.settle();
    await until(() => mock.hostedReceipts.some((r) => r.accessId === two.accessId), 15_000, 'reçu deux');
    expect(mock.hostedReceipts.find((r) => r.accessId === two.accessId)!.receipt.reason).toBe('tier');

    const three = await mock.createHostedAccess('Trois', { hostName: 'trois-cd34', key: h.key.pinned });
    await mock.grant(three.accessId, clients, 'r');
    await h.settle();
    await until(async () => (await h.fetch(`https://trois-cd34.${TEST_DOMAIN}/health`)).status === 200, 15_000, 'trois prête');
    mock.hostingErase(three.accessId, { redirectTo: 'https://gate.example.org/', legacy: true });
    await h.settle();
    await until(() => mock.hostedReceipts.some((r) => r.accessId === three.accessId), 15_000, 'reçu trois');
    expect(mock.hostedReceipts.find((r) => r.accessId === three.accessId)!.receipt.reason).toBe('migrated');
    const redirected = await h.fetch(`https://trois-cd34.${TEST_DOMAIN}/v1/clients?limit=1`, { redirect: 'manual' });
    expect(redirected.status).toBe(308);
    expect(redirected.headers.get('location')).toBe('https://gate.example.org/v1/clients?limit=1');
  }, 60_000);

  it('adresses : contrôle, nom inconnu, autre domaine', async () => {
    expect(await (await h.fetch(`${CTL}/health`)).json()).toMatchObject({ status: 'ok', version: HOST_VERSION });
    expect((await h.fetch(`${CTL}/v1/clients`)).status).toBe(404);
    expect((await h.fetch(`https://inconnu-zz99.${TEST_DOMAIN}/health`)).status).toBe(404);
    expect((await h.fetch(`https://pas-un-nom.${TEST_DOMAIN}/health`)).status).toBe(404);
    expect((await h.fetch('https://site-vitrine-7qm2.gate.filarr.com.example.org/health')).status).toBe(404);
    expect((await h.fetch(`${CTL}/_filarr/notify/court`, { method: 'POST' })).status).toBe(404);
    // Une clé publique du service n'est jamais une clé privée : rien d'autre que la liste publique n'est servi
    expect(toBase64Std(new Uint8Array(32))).toHaveLength(44);
  });
});

describe('le reçu (PH9, PH10)', () => {
  it('la raison de l’API telle quelle ; sinon la déduction d’avant', () => {
    expect(erasureReason({ eraseReason: 'pending_expired', sleepReason: 'billing', redirectTo: null })).toBe('pending_expired');
    expect(erasureReason({ eraseReason: 'migrated', sleepReason: null, redirectTo: null })).toBe('migrated');
    expect(erasureReason({ eraseReason: 'inconnue', sleepReason: 'tier', redirectTo: null })).toBe('tier');
    expect(erasureReason({ sleepReason: null, redirectTo: 'https://x.example.org' })).toBe('migrated');
    expect(erasureReason({ sleepReason: null, redirectTo: null })).toBe('revoked');
  });

  it('un retrait partiel porte sa cause DANS le message signé', () => {
    const sigKey = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
    const receipt: ErasureReceipt = { v: 1, kind: 'filarr-gate-host/erasure', keyId: 'h', accessId: 'AAAAAAAAAAAAAAAAAAAAAA', hostName: 'x-ab12', reason: 'withdrawn', cause: 'vault_admin', stores: [{ storeId: 'BBBBBBBBBBBBBBBBBBBBBB', g: 2 }], erased: ['dbKeys', 'copy'], requestedAt: '2026-10-10T00:00:00.000Z', erasedAt: '2026-10-10T00:00:01.000Z', version: '0.2.0', codeHash: '' };
    const sig = signReceipt({ privateKey: sigKey }, receipt);
    const pub = curves.ed25519PublicKey(sigKey);
    expect(receiptMessage(receipt)).toContain('"cause":"vault_admin"');
    expect(verifyHostSignature(receiptMessage(receipt), sig, pub)).toBe(true);
    const { cause: _c, ...without } = receipt;
    expect(verifyHostSignature(receiptMessage(without), sig, pub)).toBe(false);
  });
});

describe('l’annuaire', () => {
  it('un nom tenu par un accès vivant ne passe pas à un autre ; la pierre tombale garde la redirection', async () => {
    const d = new Directory(new MemoryDoStorage());
    expect(await d.register('site-ab12', 'AAAAAAAAAAAAAAAAAAAAAA')).toBe(true);
    expect(await d.register('site-ab12', 'BBBBBBBBBBBBBBBBBBBBBB')).toBe(false);
    expect(await d.register('ctl', 'AAAAAAAAAAAAAAAAAAAAAA')).toBe(false);
    expect(await d.tombstone('site-ab12', 'BBBBBBBBBBBBBBBBBBBBBB', null)).toBe(false);
    expect(await d.tombstone('site-ab12', 'AAAAAAAAAAAAAAAAAAAAAA', { to: 'http://pas-https.example.org', until: '2030-01-01T00:00:00.000Z' })).toBe(true);
    expect(await d.lookup('site-ab12')).toEqual({ a: 'AAAAAAAAAAAAAAAAAAAAAA', erased: true });
    expect(await d.register('site-ab12', 'BBBBBBBBBBBBBBBBBBBBBB')).toBe(true);
  });
});
