/**
 * `@filarr/gate`, la bibliothèque : `openGate` contre le Filarr en mémoire —
 * bases, lignes (filtres, tri, pages, champs), vues, SQL, changements en direct,
 * écriture, fichiers, état, réveils, fermeture.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { notifyHeader } from '../packages/core/src/engine/gate/access3';
import { storeCrypto } from '../packages/gate/src/crypto/providers';
import { GateError, openGate, type ChangeEvent, type Gate } from '../packages/gate/src/index';
import { openToken } from '../packages/gate/src/replica/token';
import { CATALOGUE_DB, CLIENTS_DB, COMMANDES_DB, demoStores } from './support/demoData';
import { MockFilarr } from './support/mockFilarr';
import { tempDir, until } from './support/util';

let mock: MockFilarr;
let gate: Gate | null = null;
const stores: Record<string, string> = {};
let token = '';
let accessId = '';

beforeEach(async () => {
  mock = new MockFilarr({ writeSwitch: true });
  await mock.listen();
  for (const spec of demoStores) stores[spec.dbId] = await mock.createStore(spec);
  ({ token, accessId } = await mock.createAccess('ERP Atelier'));
  await mock.grant(accessId, stores[CLIENTS_DB]!, 'rw');
  await mock.grant(accessId, stores[COMMANDES_DB]!, 'r');
  await mock.grant(accessId, stores[CATALOGUE_DB]!, 'r');
});

afterEach(async () => {
  await gate?.close();
  gate = null;
  await mock.close();
});

describe('openGate : lire', () => {
  it('rend les bases ouvertes, leurs champs et leurs vues', async () => {
    gate = await openGate({ token, apiUrl: mock.url });
    const bases = gate.bases();
    expect(bases.map((b) => b.slug)).toEqual(['catalogue', 'clients', 'commandes']);
    const clients = bases.find((b) => b.slug === 'clients')!;
    expect(clients).toMatchObject({ title: 'Clients', rights: 'rw', status: 'ready', rows: 4 });
    expect(clients.fields.find((f) => f.name === 'statut')).toMatchObject({ column: 'Statut', type: 'select', json: 'string', options: ['Prospect', 'Client', 'Perdu'] });
    expect(clients.views.map((v) => v.slug)).toEqual(['tous-les-clients', 'clients-actifs', 'a-relancer']);
    expect(gate.accessName).toBe('ERP Atelier');
  });

  it('lignes : filtres, tri, pages, champs ; une ligne ; relations et agrégats', async () => {
    gate = await openGate({ token, apiUrl: mock.url });
    const clients = gate.base('clients');
    const all = await clients.rows({ sort: 'nom' });
    expect(all.map((r) => r.nom)).toEqual(['Acme', 'Globex', 'Initech', 'Umbrella']);
    expect(all.total).toBe(4);
    expect(all.version).toBeGreaterThan(0);
    const rich = await clients.rows({ where: { statut: 'Client', ca: { gte: 10_000 } } });
    expect(rich.map((r) => r.nom)).toEqual(['Acme']);
    const page1 = await clients.rows({ sort: ['-ca'], limit: 2, fields: ['nom'] });
    expect(page1.map((r) => Object.keys(r).sort())).toEqual([['id', 'nom'], ['id', 'nom']]);
    expect(page1.next).not.toBeNull();
    const page2 = await clients.rows({ sort: ['-ca'], limit: 2, cursor: page1.next!, fields: ['nom'] });
    expect([...page1, ...page2].map((r) => r.nom)).toEqual(['Acme', 'Globex', 'Umbrella', 'Initech']);
    const acme = await clients.row('r_acme');
    expect(acme).toMatchObject({ nom: 'Acme', statut: 'Client', total_commande: 1540.5 });
    expect(await clients.row('r_inconnue')).toBeNull();
    expect((await clients.rows({ where: { ville: { in: ['Lyon', 'Paris'] } } })).length).toBe(2);
  });

  it('vues : rejouées par le moteur de Filarr (filtres, tri, colonnes masquées), vue Requête comprise', async () => {
    gate = await openGate({ token, apiUrl: mock.url });
    const actifs = await gate.base('clients').view('clients-actifs').rows();
    expect(actifs.map((r) => r.nom)).toEqual(['Acme', 'Globex']);
    expect(actifs[0]).not.toHaveProperty('commandes');
    const parVille = await gate.base('commandes').view('chiffre-par-ville').rows();
    expect(parVille[0]).toMatchObject({ ville: 'Lyon', commandes: 2, chiffre: 1540.5 });
  });

  it('SQL en lecture seule, sur toutes les bases ou certaines', async () => {
    gate = await openGate({ token, apiUrl: mock.url });
    const out = await gate.sql('SELECT nom FROM clients WHERE ca > 5000 ORDER BY nom');
    expect(out.rows).toEqual([['Acme'], ['Globex']]);
    await expect(gate.sql('DELETE FROM clients')).rejects.toMatchObject({ code: 'sql_read_only' });
    await expect(gate.sql('SELECT 1 FROM clients', { bases: ['inconnue'] })).rejects.toBeInstanceOf(GateError);
  });

  it('base ou vue inconnue : une GateError au code stable', async () => {
    gate = await openGate({ token, apiUrl: mock.url });
    expect(() => gate!.base('fournisseurs')).toThrow(GateError);
    try {
      gate.base('clients').view('nope');
    } catch (err) {
      expect(err).toMatchObject({ status: 404, code: 'view_not_found' });
    }
  });

  it('jeton révoqué, ou qui n’est pas un jeton : openGate rejette', async () => {
    await expect(openGate({ token: 'flr_live_nimporte', apiUrl: mock.url })).rejects.toThrow();
    await mock.revoke(accessId);
    await expect(openGate({ token, apiUrl: mock.url })).rejects.toMatchObject({ code: 'api_access_revoked' });
  });
});

describe('openGate : en direct', () => {
  it('on("change") : les lignes ajoutées, changées et retirées dans Filarr', async () => {
    gate = await openGate({ token, apiUrl: mock.url });
    await until(() => gate!.status().link === 'live', 5000, 'flux');
    const events: ChangeEvent[] = [];
    const off = gate.on('change', (e) => events.push(e));
    await mock.appEdit(stores[CLIENTS_DB]!, [{ r: 'r_acme', f: 'p_ville', v: 'Villeurbanne' }]);
    await until(() => events.length > 0, 5000, 'changement');
    expect(events[0]).toMatchObject({ base: 'clients', origin: 'filarr' });
    expect(events[0]!.changed[0]!.before.ville).toBe('Lyon');
    expect(events[0]!.changed[0]!.after.ville).toBe('Villeurbanne');
    off();
  });

  it('live: false — une copie à l’ouverture, refresh() et wake() à la demande', async () => {
    gate = await openGate({ token, apiUrl: mock.url, live: false });
    await mock.appEdit(stores[CLIENTS_DB]!, [{ r: 'r_acme', f: 'p_ville', v: 'Bron' }]);
    expect((await gate.base('clients').row('r_acme'))!.ville).toBe('Lyon');
    await gate.refresh();
    expect((await gate.base('clients').row('r_acme'))!.ville).toBe('Bron');

    // Un réveil reçu par votre serveur : vérifié, puis relu
    await mock.appEdit(stores[CLIENTS_DB]!, [{ r: 'r_acme', f: 'p_ville', v: 'Caluire' }]);
    const id = await openToken(token);
    const body = JSON.stringify({ a: accessId, t: 'commit', storeId: stores[CLIENTS_DB], at: new Date().toISOString() });
    expect(await gate.wake(body, 't=1,v1=00')).toBe(false);
    expect(await gate.wake(body, await notifyHeader(storeCrypto, id.aNotify, body, Math.floor(Date.now() / 1000)))).toBe(true);
    expect((await gate.base('clients').row('r_acme'))!.ville).toBe('Caluire');
  });

  it('cache { dir } : des blocs chiffrés seulement, relus au lancement suivant', async () => {
    const dir = tempDir();
    gate = await openGate({ token, apiUrl: mock.url, cache: { dir }, live: false });
    await gate.close();
    const before = mock.requests.filter((r) => r.path.endsWith('slots:batchGet')).length;
    gate = await openGate({ token, apiUrl: mock.url, cache: { dir }, live: false });
    expect(mock.requests.filter((r) => r.path.endsWith('slots:batchGet')).length).toBe(before);
    expect((await gate.base('clients').rows()).length).toBe(4);
  });
});

describe('openGate : écrire', () => {
  it('write: false d’office — rien ne part', async () => {
    gate = await openGate({ token, apiUrl: mock.url });
    await expect(gate.base('clients').insert({ nom: 'Hooli' })).rejects.toMatchObject({ code: 'write_disabled' });
  });

  it('insert, update, delete, validés par Filarr ; l’application relit', async () => {
    gate = await openGate({ token, apiUrl: mock.url, write: true });
    const clients = gate.base('clients');
    const hooli = await clients.insert({ nom: 'Hooli', ville: 'Palo Alto' });
    expect(hooli).toMatchObject({ nom: 'Hooli', statut: 'Prospect' }); // l'option par défaut de la colonne
    const [a, b] = await clients.insert([{ nom: 'Pied Piper' }, { nom: 'Raviga' }]);
    expect(a!.id).not.toBe(b!.id);
    const updated = await clients.update(hooli.id, { statut: 'Client', ca: 4200 });
    expect(updated).toMatchObject({ statut: 'Client', ca: 4200 });
    await clients.delete(b!.id);
    const app = await mock.appRows(stores[CLIENTS_DB]!);
    expect(app.find((r) => r.id === hooli.id)?.cells.p_ca).toBe(4200);
    expect(app.some((r) => r.id === b!.id)).toBe(false);
    await expect(clients.update(hooli.id, { statut: 'Inconnu' })).rejects.toMatchObject({ code: 'unknown_option' });
    await expect(gate.base('commandes').insert({ numero: 'X' })).rejects.toMatchObject({ code: 'base_read_only' });
  });
});

describe('openGate : fichiers et état', () => {
  it('files.deposit dépose dans la boîte liée ; files.status suit le rangement', async () => {
    mock.linkFiles(accessId);
    gate = await openGate({ token, apiUrl: mock.url });
    expect(gate.status()).toMatchObject({ creator: 'authenticated', files: { linked: true, signed: true } });
    const csv = 'date;montant\n2026-10-09;12\n';
    const dep = await gate.files.deposit(csv, { name: 'export.csv', tags: ['nuit'] });
    expect(dep).toMatchObject({ status: 'deposited', sizeBytes: new TextEncoder().encode(csv).length });
    mock.fileDeposit(dep.depositId);
    expect((await gate.files.status(dep.depositId)).status).toBe('filed');
    await expect(gate.files.deposit(new Uint8Array([0x7f, 0x45, 0x4c, 0x46]), { name: 'a.bin' })).rejects.toMatchObject({ code: 'file_type_refused' });
  });

  it('status() dit la liaison, le palier, les bases et le quota ; close() efface la mémoire', async () => {
    gate = await openGate({ token, apiUrl: mock.url });
    const s = gate.status();
    expect(s).toMatchObject({ accessId, accessName: 'ERP Atelier', tier: 'pro', filarrWrite: true });
    expect(s.bases.every((b) => b.status === 'ready')).toBe(true);
    expect(s.quota?.sync?.max).toBeGreaterThan(0);
    await gate.close();
    expect(() => gate!.base('clients')).toThrow();
    gate = null;
  });
});
