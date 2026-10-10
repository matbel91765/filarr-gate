/**
 * Les connecteurs des bases externes (`source-externe-1` § 1, § 6.6), un par un :
 * PostgreSQL RÉEL (une instance jetable sur un port privé), D1, Supabase,
 * Airtable, Notion et Google Sheets par des services simulés, un CSV et un JSON
 * publiés, MySQL par un pilote factice (aucun serveur MySQL sur cette machine :
 * on vérifie le dialecte et l'écriture sous condition).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ExtSourceDef, SourceOp } from '../packages/core/src/engine/extsrc';
import { openConnector, type ConnectorContext } from '../packages/server/src/sync/connectors';
import { a1, serviceAccountAssertion } from '../packages/server/src/sync/connectors/gsheets';
import { parseCsv } from '../packages/server/src/sync/connectors/url';
import { AirtableSim, D1Sim, NotionSim, routeFetch, SheetsSim, SupabaseSim } from './support/simulators';
import { startPostgres, type TempPostgres } from './support/postgres';

const baseDef = (over: Partial<ExtSourceDef>): ExtSourceDef => ({
  v: 1,
  id: 'xs_AAAAAAAAAAAAAAAAAAAAAA',
  rev: 1,
  name: 'Essai',
  connector: 'd1',
  conn: {},
  host: '',
  from: { table: 'clients' },
  key: { cols: ['id'], gen: 'source' },
  marker: { col: 'maj_le', kind: 'iso' },
  mode: 'both',
  map: [
    { col: 'id', prop: 'p_id', dir: 'in', type: 'number' },
    { col: 'nom', prop: 'p_nom', dir: 'both', type: 'text' },
  ],
  conflict: 'source',
  rowConflict: 'delete',
  runner: { kind: 'gate', accessId: 'a' },
  schedule: { every: '15m' },
  signer: 'u',
  ...over,
});

const ctx = (def: ExtSourceDef, secret: string, f: typeof fetch = fetch): ConnectorContext => ({
  def,
  secret,
  fetch: f,
  loadDriver: async (n) => import(n),
  props: {},
  sleep: async () => undefined,
});

const update = (key: string, col: string, value: unknown, old: unknown, keyValues: Record<string, unknown> = { id: Number(key) }): SourceOp => ({ kind: 'update', key, keyValues, col, value, old, rowId: `r${key}`, prop: `p_${col}` });

// ==================== PostgreSQL ====================

let pg: TempPostgres | null = null;
beforeAll(() => {
  pg = startPostgres(3070);
}, 120_000);
afterAll(() => pg?.stop());

describe('postgres (réel)', () => {
  const def = () =>
    baseDef({
      connector: 'postgres',
      conn: { host: pg!.host, port: pg!.port, db: pg!.db, user: pg!.user, tls: 'off-local' },
      host: `${pg!.host}:${pg!.port}`,
      map: [
        { col: 'id', prop: 'p_id', dir: 'in', type: 'number' },
        { col: 'nom', prop: 'p_nom', dir: 'both', type: 'text' },
        { col: 'montant', prop: 'p_m', dir: 'both', type: 'number' },
        { col: 'jour', prop: 'p_j', dir: 'both', type: 'date' },
        { col: 'actif', prop: 'p_a', dir: 'both', type: 'checkbox' },
      ],
    });

  it('lit, écrit sous condition (IS NOT DISTINCT FROM), relit l’arrondi, insère avec RETURNING, supprime', async (t) => {
    if (!pg) return t.skip();
    const setup = await openConnector(ctx(def(), pg.password), { tcp: true });
    // La table, par le pilote lui-même (une requête hors connecteur)
    const { Client } = (await import('pg')).default;
    const admin = new Client({ host: pg.host, port: pg.port, user: pg.user, password: pg.password, database: pg.db });
    await admin.connect();
    await admin.query('DROP TABLE IF EXISTS clients; CREATE TABLE clients (id serial PRIMARY KEY, nom text, montant numeric(10,2), jour date, actif boolean, maj_le timestamptz DEFAULT now())');
    await admin.query("INSERT INTO clients (nom, montant, jour, actif, maj_le) VALUES ('Acme', 10.5, '2026-10-01', true, '2026-10-01T08:00:00Z'), ('Globex', NULL, NULL, false, '2026-10-05T08:00:00Z')");
    await setup.close();

    const c = await openConnector(ctx(def(), pg.password), { tcp: true });
    const all = await c.readAll();
    expect(all.map((r) => r.raw.nom)).toEqual(['Acme', 'Globex']);
    expect(all[0]!.raw.jour).toBe('2026-10-01'); // une date reste une date
    const since = await c.readSince(Date.parse('2026-10-03T00:00:00Z'));
    expect(since.map((r) => r.raw.nom)).toEqual(['Globex']);
    expect((await c.readKeys([{ id: 2 }])).map((r) => r.raw.nom)).toEqual(['Globex']);
    const res = await c.write([
      update('1', 'montant', 12.345, '10.50'),
      update('2', 'nom', 'Globex SA', 'Pas la bonne valeur'),
      update('2', 'montant', 7, null),
      { kind: 'insert', rowId: 'db-neuve', values: { nom: 'Hooli', montant: 1, actif: true } },
      { kind: 'delete', key: '1', keyValues: { id: 1 }, rowId: 'r1' },
    ]);
    expect(res.failed).toEqual([{ key: '2', col: 'nom' }]);
    expect(res.reread.get('2')!.montant).toBe('7.00');
    expect(res.inserted[0]!.keyValues).toEqual({ id: 3 });
    const after = await c.readAll();
    expect(after.map((r) => r.raw.nom)).toEqual(['Globex', 'Hooli']);
    await c.close();
    // L'arrondi de la source se relit (l'écho du § 6.5)
    const c2 = await openConnector(ctx(def(), pg.password), { tcp: true });
    const r3 = await c2.write([update('3', 'montant', 2.555, '1.00')]);
    expect(r3.reread.get('3')!.montant).toBe('2.56');
    await c2.close();
    // Une source « query » se lit en lecture seule et ne s'écrit pas
    const q = await openConnector(ctx({ ...def(), mode: 'mirror', from: { query: 'SELECT id, nom, montant, jour, actif, maj_le FROM clients WHERE actif' } }, pg.password), { tcp: true });
    expect((await q.readAll()).map((r) => r.raw.nom)).toEqual(['Hooli']);
    await expect(q.write([update('3', 'nom', 'x', 'Hooli')])).rejects.toThrow();
    await q.close();
    await admin.end();
  }, 60_000);

  it('mauvais mot de passe : extdb_key_refused ; hôte fermé : extdb_unreachable', async (t) => {
    if (!pg) return t.skip();
    await expect(openConnector(ctx(def(), 'faux'), { tcp: true })).rejects.toMatchObject({ code: 'extdb_key_refused' });
    await expect(openConnector(ctx({ ...def(), conn: { ...def().conn, port: 3071 } }, pg.password), { tcp: true })).rejects.toMatchObject({ code: 'extdb_unreachable' });
    await expect(openConnector(ctx(def(), pg.password), { tcp: false })).rejects.toMatchObject({ code: 'extdb_unreachable' });
  }, 60_000);
});

// ==================== MySQL (pilote factice) ====================

describe('mysql (dialecte)', () => {
  it('backticks, <=>, LAST_INSERT_ID, transaction, FOUND_ROWS', async () => {
    const calls: Array<{ sql: string; params?: unknown[] }> = [];
    let cfg: Record<string, unknown> = {};
    const fake = {
      createConnection: async (c: Record<string, unknown>) => {
        cfg = c;
        return {
          execute: async (sql: string, params: unknown[]) => {
            calls.push({ sql, params });
            if (sql.startsWith('SELECT')) return [[{ id: 1, nom: 'Acme', maj_le: '2026-10-01' }], []];
            if (sql.startsWith('UPDATE')) return [{ affectedRows: params[2] === 'Acme' ? 1 : 0 }, []];
            if (sql.startsWith('INSERT')) return [{ affectedRows: 1, insertId: 42 }, []];
            return [{ affectedRows: 1 }, []];
          },
          query: async (sql: string) => calls.push({ sql }),
          end: async () => undefined,
        };
      },
    };
    const def = baseDef({ connector: 'mysql', conn: { host: 'db.lan', db: 'erp', user: 'u', tls: 'off-local' }, host: 'db.lan:3306' });
    const c = await openConnector({ ...ctx(def, 'mdp'), loadDriver: async () => fake }, { tcp: true });
    expect(cfg).toMatchObject({ host: 'db.lan', port: 3306, database: 'erp', user: 'u', password: 'mdp', flags: ['FOUND_ROWS'] });
    await c.readAll();
    expect(calls[0]!.sql).toBe('SELECT `id`, `nom`, `maj_le` FROM `clients` ORDER BY `id` LIMIT 1000');
    const res = await c.write([update('1', 'nom', 'Acme SA', 'Acme'), update('1', 'nom', 'X', 'Autre'), { kind: 'insert', rowId: 'n', values: { nom: 'Hooli' } }]);
    expect(calls.some((x) => x.sql === 'UPDATE `clients` SET `nom` = ? WHERE `id` = ? AND `nom` <=> ?')).toBe(true);
    expect(calls.some((x) => x.sql === 'START TRANSACTION')).toBe(true);
    expect(calls.some((x) => x.sql === 'COMMIT')).toBe(true);
    expect(res.failed).toEqual([{ key: '1', col: 'nom' }]);
    expect(res.inserted[0]!.keyValues).toEqual({ id: 42 });
  });
});

// ==================== D1 ====================

describe('d1', () => {
  it('écriture sous condition : 0 ligne touchée = la source a changé', async () => {
    const d1 = new D1Sim();
    d1.exec('CREATE TABLE clients (id INTEGER PRIMARY KEY, nom TEXT, maj_le TEXT)');
    d1.exec("INSERT INTO clients VALUES (1, 'Acme', '2026-10-01T00:00:00Z')");
    const def = baseDef({ conn: { account: 'a', database: 'b' }, host: 'api.cloudflare.com' });
    const c = await openConnector(ctx(def, d1.token, routeFetch({ 'api.cloudflare.com': d1.handler })), { tcp: false });
    const res = await c.write([update('1', 'nom', 'Acme SA', 'Pas ça'), { kind: 'insert', rowId: 'x', values: { nom: 'Hooli' } }]);
    expect(res.failed).toHaveLength(1);
    expect(res.inserted[0]!.keyValues).toEqual({ id: 2 });
    await expect((await openConnector(ctx(def, 'faux', routeFetch({ 'api.cloudflare.com': d1.handler })), { tcp: false })).readAll()).rejects.toMatchObject({ code: 'extdb_key_refused' });
  });
});

// ==================== Supabase ====================

describe('supabase', () => {
  it('pages ordonnées, gte sur le repère, PATCH sous condition (eq / is.null), POST, DELETE', async () => {
    const sb = new SupabaseSim();
    sb.db.exec('CREATE TABLE clients (id INTEGER PRIMARY KEY, nom TEXT, maj_le TEXT)');
    sb.db.exec("INSERT INTO clients VALUES (1, 'Acme', '2026-10-01T00:00:00Z'), (2, NULL, '2026-10-05T00:00:00Z')");
    const def = baseDef({ connector: 'supabase', conn: { url: 'https://abcd.supabase.co' }, host: 'abcd.supabase.co' });
    const log: Array<{ method: string; url: string; auth: string | null }> = [];
    const c = await openConnector(ctx(def, sb.key, routeFetch({ 'abcd.supabase.co': sb.handler }, log)), { tcp: false });
    expect((await c.readAll()).map((r) => r.raw.id)).toEqual([1, 2]);
    expect((await c.readSince(Date.parse('2026-10-03T00:00:00Z'))).map((r) => r.raw.id)).toEqual([2]);
    const res = await c.write([update('1', 'nom', 'Acme SA', 'Acme'), update('2', 'nom', 'Globex', null), update('1', 'nom', 'X', 'Pas ça'), { kind: 'insert', rowId: 'n', values: { nom: 'Hooli' } }, { kind: 'delete', key: '2', keyValues: { id: 2 }, rowId: 'r2' }]);
    expect(res.failed).toEqual([{ key: '1', col: 'nom' }]);
    expect(res.inserted[0]!.keyValues).toEqual({ id: 3 });
    expect((await c.readAll()).map((r) => r.raw.nom)).toEqual(['Acme SA', 'Hooli']);
    expect(log.every((l) => l.auth === `Bearer ${sb.key}`)).toBe(true);
  });
});

// ==================== Airtable ====================

describe('airtable', () => {
  it('pages de 100, relecture avant écriture, 10 par appel, identifiant d’enregistrement en clé', async () => {
    const at = new AirtableSim();
    for (let i = 0; i < 150; i += 1) at.add({ Nom: `Client ${i}`, Modifié: '2026-10-01T00:00:00.000Z' });
    const def = baseDef({ connector: 'airtable', conn: { base: 'appXYZ', table: 'Clients' }, host: 'api.airtable.com', key: { cols: ['id'], gen: 'source' }, marker: { col: 'Modifié', kind: 'iso' }, map: [{ col: 'id', prop: 'p_id', dir: 'in', type: 'text' }, { col: 'Nom', prop: 'p_nom', dir: 'both', type: 'text' }] });
    const c = await openConnector(ctx(def, at.token, routeFetch({ 'api.airtable.com': at.handler })), { tcp: false });
    const all = await c.readAll();
    expect(all).toHaveLength(150);
    const first = all[0]!.raw;
    const res = await c.write([
      { kind: 'update', key: String(first.id), keyValues: { id: first.id }, col: 'Nom', value: 'Acme', old: 'Client 0', rowId: 'r', prop: 'p_nom' },
      { kind: 'update', key: String(all[1]!.raw.id), keyValues: { id: all[1]!.raw.id }, col: 'Nom', value: 'X', old: 'Changé entre-temps', rowId: 'r', prop: 'p_nom' },
      { kind: 'insert', rowId: 'db-n', values: { Nom: 'Hooli' } },
      { kind: 'delete', key: String(all[2]!.raw.id), keyValues: { id: all[2]!.raw.id }, rowId: 'r' },
    ]);
    expect(res.failed).toHaveLength(1);
    expect(at.records.get(String(first.id))!.fields.Nom).toBe('Acme');
    expect(res.inserted[0]!.keyValues!.id).toMatch(/^rec/);
    expect(at.records.has(String(all[2]!.raw.id))).toBe(false);
  });
});

// ==================== Notion ====================

describe('notion', () => {
  it('version figée, pages de 100, propriétés en valeurs simples, mise à jour relue, création, corbeille', async () => {
    const nt = new NotionSim({ Nom: 'title', Statut: 'select', Montant: 'number', Tags: 'multi_select', Échéance: 'date' });
    const ids = Array.from({ length: 120 }, (_, i) => nt.add({ Nom: `P${i}`, Statut: 'Actif', Montant: i, Tags: ['a'], Échéance: '2026-10-10' }));
    const def = baseDef({ connector: 'notion', conn: { database: 'db-notion' }, host: 'api.notion.com', marker: { col: 'last_edited_time', kind: 'iso' }, map: [{ col: 'id', prop: 'p_id', dir: 'in', type: 'text' }, { col: 'Nom', prop: 'p_nom', dir: 'both', type: 'text' }, { col: 'Statut', prop: 'p_s', dir: 'both', type: 'select' }] });
    const c = await openConnector(ctx(def, nt.token, routeFetch({ 'api.notion.com': nt.handler })), { tcp: false });
    const all = await c.readAll();
    expect(all).toHaveLength(120);
    expect(all[3]!.raw).toMatchObject({ Nom: 'P3', Statut: 'Actif', Montant: 3, Tags: ['a'], Échéance: '2026-10-10' });
    const res = await c.write([
      { kind: 'update', key: ids[0]!, keyValues: { id: ids[0] }, col: 'Statut', value: 'Perdu', old: 'Actif', rowId: 'r', prop: 'p_s' },
      { kind: 'update', key: ids[1]!, keyValues: { id: ids[1] }, col: 'Nom', value: 'X', old: 'Autre', rowId: 'r', prop: 'p_nom' },
      { kind: 'insert', rowId: 'db-n', values: { Nom: 'Neuf', Statut: 'Actif' } },
      { kind: 'delete', key: ids[2]!, keyValues: { id: ids[2] }, rowId: 'r' },
    ]);
    expect(res.failed).toEqual([{ key: ids[1], col: 'Nom' }]);
    expect(res.reread.get(ids[0]!)!.Statut).toBe('Perdu');
    expect(res.inserted).toHaveLength(1);
    expect(nt.pages.get(ids[2]!)!.archived).toBe(true);
  });
});

// ==================== Google Sheets ====================

async function serviceAccount(): Promise<string> {
  const pair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  const der = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
  const b64 = Buffer.from(der).toString('base64').replace(/(.{64})/g, '$1\n');
  return JSON.stringify({ type: 'service_account', client_email: 'gate@projet.iam.gserviceaccount.com', private_key: `-----BEGIN PRIVATE KEY-----\n${b64}\n-----END PRIVATE KEY-----\n`, token_uri: 'https://oauth2.googleapis.com/token' });
}

describe('gsheets', () => {
  it('assertion RS256 signée dans la boîte, onglet entier, ligne retrouvée par sa clé, ajout, effacement', async () => {
    const sh = new SheetsSim(['cle', 'Produit', 'Prix']);
    sh.values.push(['k1', 'Table', 890], ['k2', 'Chaise', 120], ['k3', 'Lampe', 45]);
    const sa = await serviceAccount();
    const def = baseDef({ connector: 'gsheets', conn: { spreadsheet: 'sheet123', tab: 'Tarifs' }, host: 'sheets.googleapis.com', key: { cols: ['cle'], gen: 'runner' }, marker: null, map: [{ col: 'cle', prop: 'p_k', dir: 'in', type: 'text' }, { col: 'Prix', prop: 'p_p', dir: 'both', type: 'number' }] });
    const log: Array<{ method: string; url: string; auth: string | null }> = [];
    const c = await openConnector(ctx(def, sa, routeFetch({ 'sheets.googleapis.com': sh.handler, 'oauth2.googleapis.com': sh.oauth }, log)), { tcp: false });
    expect((await c.readAll()).map((r) => r.raw.Produit)).toEqual(['Table', 'Chaise', 'Lampe']);
    const res = await c.write([
      { kind: 'update', key: 'k2', keyValues: { cle: 'k2' }, col: 'Prix', value: 99, old: 120, rowId: 'r', prop: 'p_p' },
      { kind: 'update', key: 'k1', keyValues: { cle: 'k1' }, col: 'Prix', value: 1, old: 999, rowId: 'r', prop: 'p_p' },
      { kind: 'insert', rowId: 'ext-NOUVELLE', values: { Produit: 'Banc', Prix: 300 } },
      { kind: 'delete', key: 'k3', keyValues: { cle: 'k3' }, rowId: 'r' },
    ]);
    expect(res.failed).toEqual([{ key: 'k1', col: 'Prix' }]);
    expect(sh.values).toEqual([['cle', 'Produit', 'Prix'], ['k1', 'Table', 890], ['k2', 'Chaise', 99], ['ext-NOUVELLE', 'Banc', 300]]);
    // La clé privée ne part jamais : seule l'assertion signée va chez Google
    expect(log.filter((l) => l.url.startsWith('https://oauth2.googleapis.com')).length).toBe(1);
    expect(sh.assertions[0]!.split('.')).toHaveLength(3);
    expect(a1(0, 1)).toBe('A1');
    expect(a1(27, 3)).toBe('AB3');
    const parsed = JSON.parse(Buffer.from(sh.assertions[0]!.split('.')[1]!, 'base64url').toString()) as Record<string, unknown>;
    expect(parsed).toMatchObject({ iss: 'gate@projet.iam.gserviceaccount.com', aud: 'https://oauth2.googleapis.com/token' });
    void serviceAccountAssertion;
  });

  it('un token_uri hors de oauth2.googleapis.com est refusé (la clé reste liée à son hôte)', async () => {
    const sa = JSON.parse(await serviceAccount()) as Record<string, string>;
    sa.token_uri = 'https://evil.example/token';
    const def = baseDef({ connector: 'gsheets', conn: { spreadsheet: 's', tab: 't' }, host: 'sheets.googleapis.com', key: { cols: ['cle'], gen: 'runner' } });
    await expect(openConnector(ctx(def, JSON.stringify(sa)), { tcp: false })).rejects.toMatchObject({ code: 'extdb_key_refused' });
  });
});

// ==================== CSV et JSON publiés ====================

describe('url', () => {
  it('CSV (RFC 4180, séparateur, guillemets, retours dans un champ) et JSON par chemin', async () => {
    expect(parseCsv('a;b\n"x;y";"dit ""bonjour"""\n"multi\nligne";2\n', ';')).toEqual([['a', 'b'], ['x;y', 'dit "bonjour"'], ['multi\nligne', '2']]);
    const csv = (_req: Request) => new Response('id;nom\n1;Acme\n2;"Globex; SA"\n');
    const js = (_req: Request) => new Response(JSON.stringify({ data: { items: [{ id: 1, nom: 'A' }, { id: 2, nom: 'B' }] } }));
    const d1 = baseDef({ connector: 'url', conn: { url: 'https://export.example.com/c.csv', format: { kind: 'csv', sep: ';' } }, host: 'export.example.com', mode: 'mirror', marker: null });
    const c = await openConnector(ctx(d1, '', routeFetch({ 'export.example.com': csv })), { tcp: false });
    expect((await c.readAll()).map((r) => r.raw)).toEqual([{ id: '1', nom: 'Acme' }, { id: '2', nom: 'Globex; SA' }]);
    await expect(c.write([])).rejects.toThrow();
    const d2 = baseDef({ connector: 'url', conn: { url: 'https://export.example.com/c.json', format: { kind: 'json', items: '$.data.items' } }, host: 'export.example.com', mode: 'mirror', marker: null });
    const c2 = await openConnector(ctx(d2, '', routeFetch({ 'export.example.com': js })), { tcp: false });
    expect((await c2.readAll()).map((r) => r.raw.nom)).toEqual(['A', 'B']);
  });
});
