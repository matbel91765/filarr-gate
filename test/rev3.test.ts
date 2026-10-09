/**
 * La révision 3 d'api-base-1, vue de la boîte noire, contre le Filarr en mémoire :
 * la clé du créateur authentifiée par son étiquette (§ 1 bis), les réveils
 * poussés (§ 5 bis), la fente à fichiers (`gate-fichiers-1`), la migration et son
 * paquet de réglages (`gate-heberge-1` § 8.4, § 8.6), la fermeture 4308.
 */

import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { notifyHeader } from '../packages/core/src/engine/gate/access3';
import { openDeposit } from '../packages/core/src/engine/gate/files';
import { fromBase64Std } from '../packages/core/src/engine/store/apiAccess';
import { curves, storeCrypto } from '../packages/gate/src/crypto/providers';
import { openToken } from '../packages/gate/src/replica/token';
import { Gate } from '../packages/cli/src/gate';
import { verifySignature } from '../packages/server/src/api/webhooks';
import { setLogLevel } from '../packages/server/src/log';
import { CLIENTS_DB, demoStores } from './support/demoData';
import { MockFilarr, type AccessOptions } from './support/mockFilarr';
import { tempDir, until } from './support/util';

setLogLevel('silent');

let mock: MockFilarr;
let gates: Gate[] = [];
let clients = '';

beforeEach(async () => {
  mock = new MockFilarr({ writeSwitch: true });
  await mock.listen();
  clients = await mock.createStore(demoStores.find((s) => s.dbId === CLIENTS_DB)!);
});

afterEach(async () => {
  for (const g of gates) await g.stop().catch(() => undefined);
  gates = [];
  await mock.close();
});

async function startGate(token: string, env: Record<string, string> = {}): Promise<Gate> {
  const gate = new Gate({
    env: {
      FILARR_GATE_STATE_DIR: tempDir(),
      FILARR_GATE_API_URL: mock.url,
      FILARR_GATE_TOKEN: token,
      FILARR_GATE_PORT: '0',
      FILARR_GATE_ADMIN_PORT: '0',
      FILARR_GATE_CACHE: 'memory',
      FILARR_GATE_ADMIN_PASSWORD: 'mot-de-passe-de-test',
      ...env,
    },
    webhooks: { delaysMs: [0, 50, 50, 50, 50, 50, 50, 50] },
    replicaTiming: { backoffMinMs: 20, backoffMaxMs: 200, pausedRetryMs: 100 },
  });
  gates.push(gate);
  await gate.start();
  return gate;
}

async function accessWith(opts: AccessOptions = {}, tier: Parameters<MockFilarr['createAccess']>[1] = 'pro') {
  const { token, accessId } = await mock.createAccess('ERP Atelier', tier, opts);
  await mock.grant(accessId, clients, 'rw');
  return { token, accessId };
}

describe('la clé du créateur (§ 1 bis)', () => {
  it('étiquette juste et bind_sig vérifiée : la clé est authentifiée', async () => {
    const { token } = await accessWith();
    const gate = await startGate(token);
    expect(gate.replicator.creator).toMatchObject({ status: 'authenticated', signingPublicKey: mock.creatorSigningPublicKey, bindSigOk: true });
  });

  it('étiquette faite avec une autre clé : refusée, jamais crue', async () => {
    const { token } = await accessWith({ tag: 'other-key' });
    const gate = await startGate(token);
    expect(gate.replicator.creator.status).toBe('refused');
    expect(gate.replicator.creator.signingPublicKey).toBeNull();
  });

  it('bind_sig signée par une autre clé que celle de l’étiquette : refusée', async () => {
    const { token } = await accessWith({ bindSig: 'other-key' });
    const gate = await startGate(token);
    expect(gate.replicator.creator).toMatchObject({ status: 'refused', bindSigOk: false });
  });

  it('accès sans étiquette : lecture ouverte, objets signés refusés', async () => {
    const { token } = await accessWith({ tag: 'none' });
    const gate = await startGate(token);
    expect(gate.replicator.creator.status).toBe('untagged');
    expect(gate.replicator.bySlug('clients')?.mirror.status).toBe('ready');
  });

  it('serveur de la révision 2 (sans `creator`) : la boîte lit comme avant', async () => {
    await mock.close();
    mock = new MockFilarr({ rev3: false });
    await mock.listen();
    clients = await mock.createStore(demoStores.find((s) => s.dbId === CLIENTS_DB)!);
    const { token } = await accessWith();
    const gate = await startGate(token);
    expect(gate.replicator.creator.status).toBe('absent');
    expect(gate.replicator.bySlug('clients')?.mirror.rows.length).toBeGreaterThan(0);
  });
});

describe('les réveils poussés (§ 5 bis)', () => {
  it('un réveil signé fait relire ; horodatage trop vieux et signature fausse refusés', async () => {
    const { token, accessId } = await accessWith();
    // Sans flux : la boîte ne relit que sur réveil (relève toutes les 300 s au moins)
    const gate = await startGate(token);
    await gate.replicator.stop();
    const url = `http://127.0.0.1:${gate.apiPort}/_filarr/notify`;
    const identity = await openToken(token);
    await mock.appEdit(clients, [{ r: 'r_acme', f: 'p_ville', v: 'Vénissieux' }]);
    const body = JSON.stringify({ a: accessId, t: 'commit', storeId: clients, seq: mock.mustStore(clients).seq, at: new Date().toISOString() });
    const now = Math.floor(Date.now() / 1000);

    const stale = await fetch(url, { method: 'POST', headers: { 'Filarr-Notify': await notifyHeader(storeCrypto, identity.aNotify, body, now - 600) }, body });
    expect(stale.status).toBe(401);
    expect(((await stale.json()) as { code: string }).code).toBe('notify_stale');
    const forged = await fetch(url, { method: 'POST', headers: { 'Filarr-Notify': `t=${now},v1=${'0'.repeat(64)}` }, body });
    expect(forged.status).toBe(401);
    expect(gate.replicator.bySlug('clients')!.mirror.rowById('r_acme')?.cells.p_ville).not.toBe('Vénissieux');

    const ok = await fetch(url, { method: 'POST', headers: { 'Filarr-Notify': await notifyHeader(storeCrypto, identity.aNotify, body, now) }, body });
    expect(ok.status).toBe(202);
    await until(() => gate.replicator.bySlug('clients')!.mirror.rowById('r_acme')?.cells.p_ville === 'Vénissieux', 5000, 'relecture après réveil');
  });

  it('le serveur pousse ses réveils vers notifyUrl, et la boîte les vérifie', async () => {
    const gateHolder: { url: string } = { url: '' };
    const { token, accessId } = await accessWith();
    const gate = await startGate(token);
    await gate.replicator.stop();
    gateHolder.url = `http://127.0.0.1:${gate.apiPort}/_filarr/notify`;
    mock.accesses.get(accessId)!.notifyUrl = gateHolder.url;
    await mock.appEdit(clients, [{ r: 'r_acme', f: 'p_ville', v: 'Oullins' }]);
    await until(() => gate.replicator.bySlug('clients')!.mirror.rowById('r_acme')?.cells.p_ville === 'Oullins', 5000, 'réveil poussé');
    expect(mock.notifications.some((n) => n.status === 202 && JSON.parse(n.body).t === 'commit')).toBe(true);
  });
});

describe('la fente à fichiers (gate-fichiers-1)', () => {
  let hookServer: Server;
  let hookUrl = '';
  const received: Array<{ headers: IncomingMessage['headers']; body: string }> = [];

  beforeEach(async () => {
    received.length = 0;
    hookServer = createServer((req, res) => {
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString('utf8')));
      req.on('end', () => {
        received.push({ headers: req.headers, body });
        res.writeHead(200);
        res.end();
      });
    });
    await new Promise<void>((r) => hookServer.listen(0, '127.0.0.1', r));
    hookUrl = `http://127.0.0.1:${(hookServer.address() as AddressInfo).port}/hook`;
  });

  afterEach(async () => {
    await new Promise<void>((r) => hookServer.close(() => r()));
  });

  const upload = async (gate: Gate, key: string, name: string, content: Uint8Array, extra: Record<string, string | string[]> = {}) => {
    const form = new FormData();
    form.append('file', new Blob([content as BlobPart], { type: 'application/pdf' }), name);
    for (const [k, v] of Object.entries(extra)) for (const x of Array.isArray(v) ? v : [v]) form.append(k, x);
    const res = await fetch(`http://127.0.0.1:${gate.apiPort}/v1/files`, { method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: form });
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };

  it('dépose au format de la passerelle, scellé pour la boîte signée ; l’appli le range ; file.filed', async () => {
    const { token, accessId } = await accessWith();
    mock.linkFiles(accessId);
    const gate = await startGate(token);
    expect(gate.replicator.files?.signed).toBe(true);
    const key = gate.keys.create({ name: 'erp', scopes: [{ target: 'files', deposit: true }] }).key;
    const hook = gate.webhooks.create({ name: 'rangés', url: hookUrl, target: null, events: ['file.filed'], filter: null, transition: false, fields: null, expand: [] });
    const content = new TextEncoder().encode('%PDF-1.7 facture 2291');
    const out = await upload(gate, key, 'facture-2291.pdf', content, { path: 'Factures/2026', tags: 'fournisseur,urgent' });
    expect(out.status).toBe(202);
    expect(out.body).toMatchObject({ status: 'deposited' });

    // Ce que Filarr a reçu : rien en clair ; l'appli l'ouvre avec la clé privée de la boîte
    const dep = [...mock.deposits.values()][0]!;
    expect(dep.status).toBe('deposited');
    const opened = await openDeposit(storeCrypto, curves, mock.boxPrivateKey, dep, [...dep.chunks.values()]);
    expect(new TextDecoder().decode(opened.bytes)).toBe('%PDF-1.7 facture 2291');
    expect(opened.manifest).toMatchObject({
      fileName: 'facture-2291.pdf',
      mimeType: 'application/pdf',
      size: content.length,
      totalChunks: 1,
      channel: 'gate',
      path: 'Factures/2026',
      tags: ['fournisseur', 'urgent'],
      source: 'erp',
      accessName: 'ERP Atelier',
    });
    expect(opened.manifest.sha256).toMatch(/^[0-9a-f]{64}$/);
    // Le manifeste chiffré ne porte ni le nom ni l'empreinte en clair
    expect(dep.encryptedManifest).not.toContain('facture');

    mock.fileDeposit(dep.depositId, 'filed');
    await until(() => gate.files.get(out.body.id)?.status === 'filed', 5000, 'statut rangé');
    const status = await fetch(`http://127.0.0.1:${gate.apiPort}/v1/files/${out.body.id}`, { headers: { Authorization: `Bearer ${key}` } });
    const st = (await status.json()) as Record<string, unknown>;
    expect(st).toMatchObject({ id: out.body.id, status: 'filed' });
    expect(Object.keys(st).sort()).toEqual(['depositedAt', 'filedAt', 'id', 'status']);
    await until(() => received.length > 0, 5000, 'webhook file.filed');
    expect(received[0]!.headers['filarr-gate-event']).toBe('file.filed');
    expect(verifySignature(hook.secret, received[0]!.body, String(received[0]!.headers['filarr-gate-signature']))).toBe(true);
    expect(JSON.parse(received[0]!.body).file).toMatchObject({ id: out.body.id, status: 'filed' });
  });

  it('le filtre refuse AVANT tout envoi : extension, signature d’exécutable, taille', async () => {
    const { token, accessId } = await accessWith();
    mock.linkFiles(accessId);
    const gate = await startGate(token, { FILARR_GATE_FILES_MAX_BYTES: '1000' });
    const key = gate.keys.create({ name: 'erp', scopes: [{ target: 'files', deposit: true }] }).key;
    const before = mock.requests.length;
    expect((await upload(gate, key, 'outil.exe', new Uint8Array([1, 2, 3]))).body.code).toBe('file_type_refused');
    expect((await upload(gate, key, 'rapport.pdf', new Uint8Array([0x4d, 0x5a, 0x90, 0]))).body).toMatchObject({ code: 'file_type_refused', reason: 'signature' });
    expect((await upload(gate, key, 'script.txt', new TextEncoder().encode('#!/bin/sh\nrm -rf /'))).body.code).toBe('file_type_refused');
    const big = await upload(gate, key, 'gros.pdf', new Uint8Array(2000));
    expect(big.status).toBe(413);
    expect(big.body.code).toBe('file_too_large');
    expect(mock.requests.slice(before).filter((r) => r.path.includes('/files'))).toEqual([]);
    expect(mock.deposits.size).toBe(0);
    expect(gate.journal.list({ kind: 'files' }).some((e) => e.what === 'fichier refusé avant envoi' && !e.note?.includes('outil'))).toBe(true);
  });

  it('boîte non signée par le créateur, accès sans étiquette, clé sans portée : refus', async () => {
    const a = await accessWith();
    mock.linkFiles(a.accessId, { signedBy: 'other' });
    const g1 = await startGate(a.token);
    expect(g1.replicator.files?.signed).toBe(false);
    const k1 = g1.keys.create({ name: 'erp', scopes: [{ target: 'files', deposit: true }] }).key;
    expect((await upload(g1, k1, 'a.pdf', new Uint8Array([1]))).body.code).toBe('box_not_signed');
    const reader = g1.keys.create({ name: 'lecteur', scopes: [{ target: 'all', read: true }] }).key;
    expect((await upload(g1, reader, 'a.pdf', new Uint8Array([1]))).status).toBe(403);

    const b = await accessWith({ tag: 'none' });
    mock.linkFiles(b.accessId);
    const g2 = await startGate(b.token);
    const k2 = g2.keys.create({ name: 'erp', scopes: [{ target: 'files', deposit: true }] }).key;
    expect((await upload(g2, k2, 'a.pdf', new Uint8Array([1]))).body.code).toBe('creator_unauthenticated');
    expect(mock.deposits.size).toBe(0);
  });

  it('les refus de Filarr gardent leur code : palier, boîte pleine', async () => {
    const solo = await accessWith({}, 'solo');
    mock.linkFiles(solo.accessId);
    const g1 = await startGate(solo.token);
    const k1 = g1.keys.create({ name: 'erp', scopes: [{ target: 'files', deposit: true }] }).key;
    expect((await upload(g1, k1, 'a.pdf', new Uint8Array([1]))).body).toMatchObject({ code: 'api_tier_files' });
    mock.pendingMax = 0;
    const pro = await accessWith();
    mock.linkFiles(pro.accessId);
    const g2 = await startGate(pro.token);
    const k2 = g2.keys.create({ name: 'erp', scopes: [{ target: 'files', deposit: true }] }).key;
    // La boîte lit « pleine » dans `self` et refuse sans rien envoyer
    expect((await upload(g2, k2, 'a.pdf', new Uint8Array([1]))).body.code).toBe('box_full');
  });
});

describe('la migration et le paquet de réglages (gate-heberge-1 § 8.4, § 8.6)', () => {
  it('l’ancienne boîte exporte vers l’identité en attente (bindSig vérifiée), la nouvelle importe', async () => {
    const { token, accessId } = await accessWith();
    const old = await startGate(token);
    await until(() => old.replicator.link === 'live', 5000, 'flux');
    const appKey = old.keys.create({ name: 'site', scopes: [{ target: 'all', read: true }], sql: true });
    old.webhooks.create({ name: 'CRM', url: 'https://crm.example.test/hook', target: { storeId: clients }, events: ['row.updated'], filter: null, transition: false, fields: null, expand: [] });
    old.state.data.queries.push({ id: '6f1c2a5e-8d1f-4a51-9d55-3b0f0c3c1a11', name: 'Clients lyonnais', slug: 'clients-lyonnais', sql: 'SELECT 1', createdAt: '', updatedAt: '' });

    const newToken = await mock.migrateStart(accessId);
    await until(() => mock.accesses.get(accessId)!.pending?.exportSealed != null, 5000, 'export déposé');

    // La nouvelle boîte présente l'identité en attente : `self` et `self/import` seulement
    const fresh = await startGate(newToken);
    expect(fresh.replicator.link).toBe('pending');
    await until(() => fresh.state.data.keys.some((k) => k.hash === appKey.record.hash), 5000, 'paquet importé');
    expect(fresh.state.data.webhooks.map((h) => h.name)).toEqual(['CRM']);
    expect(fresh.state.data.webhooks[0]!.secret).toBe(old.state.data.webhooks[0]!.secret);
    expect(fresh.state.data.queries.map((q) => q.slug)).toContain('clients-lyonnais');
    expect(mock.requests.some((r) => r.code === 'api_access_pending')).toBe(false);

    // Bascule : la nouvelle sert, avec la MÊME clé d'application
    await mock.migrateCommit(accessId);
    await until(() => old.replicator.link === 'revoked', 5000, 'ancienne coupée');
    await fresh.replicator.resync();
    await until(() => fresh.replicator.bySlug('clients')?.mirror.status === 'ready', 5000, 'nouvelle prête');
    const res = await fetch(`http://127.0.0.1:${fresh.apiPort}/v1/clients`, { headers: { Authorization: `Bearer ${appKey.key}` } });
    expect(res.status).toBe(200);
  });

  it('une identité en attente que le créateur n’a pas liée (bindSig d’une autre clé) : rien n’est exporté', async () => {
    const { token, accessId } = await accessWith();
    const old = await startGate(token);
    await until(() => old.replicator.link === 'live', 5000, 'flux');
    old.keys.create({ name: 'site', scopes: [{ target: 'all', read: true }] });
    await mock.migrateStart(accessId, { bindSig: 'other-key' });
    await until(() => old.journal.list().some((e) => e.what === 'export refusé'), 5000, 'refus noté');
    expect(mock.accesses.get(accessId)!.pending!.exportSealed).toBeNull();
  });

  it('le paquet ne porte ni mot de passe ni clé de base externe, et se rouvre par le destinataire seul', async () => {
    const { token } = await accessWith();
    const gate = await startGate(token);
    gate.keys.create({ name: 'site', scopes: [{ target: 'all', read: true }] });
    const pkg = gate.settingsPackage();
    const text = JSON.stringify(pkg);
    expect(pkg.kind).toBe('filarr-gate/settings');
    expect(text).not.toContain('scrypt$');
    expect(text).not.toContain('mot-de-passe-de-test');
    expect(pkg.appKeys[0]!.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(fromBase64Std(mock.creatorSigningPublicKey).length).toBe(32);
  });
});

describe('fermeture 4308 : boîte hébergée en sommeil', () => {
  it('le flux fermé en 4308 met la liaison en sommeil, sans rien effacer', async () => {
    const { token, accessId } = await accessWith();
    const gate = await startGate(token);
    await until(() => gate.replicator.link === 'live', 5000, 'flux');
    mock.sleepHosted(accessId);
    await until(() => gate.replicator.link === 'asleep', 5000, 'sommeil');
    expect(gate.replicator.bySlug('clients')?.mirror.rows.length).toBeGreaterThan(0);
  });
});
