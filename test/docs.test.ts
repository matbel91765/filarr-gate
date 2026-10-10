/**
 * La documentation ne ment pas :
 *  - ce qui est GÉNÉRÉ (réglages, ligne de commande, codes, OpenAPI générique, tables du
 *    dépannage), en anglais et en français, est à jour, les blocs de code recopiés d'examples/ sont
 *    identiques, chaque page a son jumeau dans l'autre langue, les liens mènent quelque part et
 *    restent dans la langue de la page, chaque variable FILARR_GATE_* existe dans le code, aucun
 *    quota de palier n'est écrit en chiffres (`npm run docs:check`, rejoué ici) ;
 *  - le texte d'accord de la boîte hébergée (`hebergement-v1`) est recopié MOT POUR MOT dans la page
 *    sécurité et confiance de chaque langue : son empreinte est celle que fixe le contrat
 *    `gate-heberge-1` (§ 3.2), recalculée ici sur la page elle-même ;
 *  - les nouveaux essais des webhooks sont décrits d'après les délais du code, dans l'interface,
 *    les pages et les README ;
 *  - l'OpenAPI générique est éprouvée route par route contre une boîte en marche : chaque
 *    opération décrite répond, avec un statut décrit.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Gate } from '../packages/cli/src/gate';
import { MAX_ATTEMPTS, RETRY_DELAYS_MIN } from '../packages/server/src/api/webhooks';
import { setLogLevel } from '../packages/server/src/log';
import { EN } from '../packages/cli/ui/src/en';
import { buildDocs } from '../scripts/docs/build';
import { CATALOGUE_DB, CLIENTS_DB, COMMANDES_DB, demoStores } from './support/demoData';
import { MockFilarr } from './support/mockFilarr';
import { tempDir, until } from './support/util';

setLogLevel('silent');

describe('npm run docs:check', () => {
  it('rien de généré n’a dérivé, aucun lien mort, aucune variable inconnue, aucun quota en chiffres', () => {
    const { changed, problems } = buildDocs({ check: true });
    expect(changed, 'lancez `npm run docs`').toEqual([]);
    expect(problems).toEqual([]);
  }, 60_000);
});

describe('le texte d’accord hebergement-v1, mot pour mot', () => {
  const vectors = JSON.parse(readFileSync(join(__dirname, 'vectors', 'gate-heberge-1.vectors.json'), 'utf8')) as {
    consent: { version: string; fr: { hash: string }; en: { hash: string } };
  };

  it.each([
    ['fr', 'security-and-trust.fr.md'],
    ['en', 'security-and-trust.md'],
  ] as const)('(%s) docs/%s le recopie à l’empreinte du contrat', (lang, page) => {
    const text = readFileSync(join(__dirname, '..', 'docs', page), 'utf8').replace(/\r\n/g, '\n');
    const marker = `<!-- consent: ${vectors.consent.version} ${lang} -->\n\`\`\`text\n`;
    const start = text.indexOf(marker);
    expect(start, `le bloc « consent: ${vectors.consent.version} ${lang} » manque`).toBeGreaterThanOrEqual(0);
    const block = text.slice(start + marker.length, text.indexOf('\n```', start + marker.length));
    // Onze lignes, {{box}} non remplacé, NFC, jointes par des sauts de ligne, sans saut final (contrat § 3.2)
    expect(block.split('\n')).toHaveLength(11);
    expect(block).toContain('{{box}}');
    expect(createHash('sha256').update(block.normalize('NFC'), 'utf8').digest('hex')).toBe(vectors.consent[lang].hash);
  });
});

describe('les nouveaux essais des webhooks, décrits d’après le code', () => {
  const n = RETRY_DELAYS_MIN.length;
  const between = RETRY_DELAYS_MIN.slice(1, -1).join(', ');
  const last = RETRY_DELAYS_MIN[n - 1];
  // La durée totale, arrondie à la demi-heure : « 10 h 30 » et « 10.5 hours »
  const halfHours = Math.round(RETRY_DELAYS_MIN.reduce((a, b) => a + b, 0) / 30);
  const fr = `${Math.floor(halfHours / 2)} h ${halfHours % 2 ? '30' : '00'}`;
  const en = `${halfHours / 2} hours`;
  const read = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8').replace(/\r\n/g, '\n').replace(/\n\s*/g, ' ');

  it('un essai par délai', () => {
    expect(MAX_ATTEMPTS).toBe(n);
  });

  it('l’interface de gestion', () => {
    const key = `${n} essais sur environ ${fr}, délai doublé à chaque échec, puis abandon noté au journal`;
    expect(read('packages/cli/ui/src/screens/Webhooks.tsx')).toContain(`t('${key}')`);
    expect(EN[key]).toContain(`${n} attempts over about ${en}`);
  });

  it.each(['docs/tutorials/webhooks', 'docs/reference/webhooks', 'docs/troubleshooting'])('%s, dans les deux langues', (page) => {
    expect(read(`${page}.md`)).toContain(`${between} and ${last} minutes`);
    expect(read(`${page}.fr.md`)).toContain(`${between} et ${last} minutes`);
  });

  // packages/cli/README*.md sont des copies de ces deux-là, faites à l'empaquetage (scripts/prepack.mjs)
  it('README, dans les deux langues', () => {
    expect(read('README.md')).toContain(`${n} attempts over about ${en}`);
    expect(read('README.fr.md')).toContain(`${n} essais sur environ ${fr}`);
  });
});

describe('docs/openapi/filarr-gate.v1.json, contre une boîte en marche', () => {
  let mock: MockFilarr;
  let gate: Gate;
  let api = '';
  let key = '';
  const stores: Record<string, string> = {};
  const spec = JSON.parse(readFileSync(join(__dirname, '..', 'docs', 'openapi', 'filarr-gate.v1.json'), 'utf8')) as {
    paths: Record<string, Record<string, { operationId: string; responses: Record<string, unknown> }>>;
  };

  beforeAll(async () => {
    mock = new MockFilarr({ writeSwitch: true });
    await mock.listen();
    for (const s of demoStores) stores[s.dbId] = await mock.createStore(s);
    const access = await mock.createAccess('OpenAPI', 'pro');
    await mock.grant(access.accessId, stores[CLIENTS_DB]!, 'rw');
    await mock.grant(access.accessId, stores[COMMANDES_DB]!, 'r');
    await mock.grant(access.accessId, stores[CATALOGUE_DB]!, 'r');
    mock.linkFiles(access.accessId);
    gate = new Gate({
      env: {
        FILARR_GATE_STATE_DIR: tempDir(),
        FILARR_GATE_API_URL: mock.url,
        FILARR_GATE_TOKEN: access.token,
        FILARR_GATE_PORT: '0',
        FILARR_GATE_ADMIN_PORT: '0',
        FILARR_GATE_CACHE: 'memory',
        FILARR_GATE_WRITE: 'true',
        FILARR_GATE_MCP: 'true',
        FILARR_GATE_ADMIN_PASSWORD: 'mot-de-passe-openapi',
      },
      replicaTiming: { backoffMinMs: 20, backoffMaxMs: 200 },
    });
    await gate.start();
    api = `http://127.0.0.1:${gate.apiPort}`;
    await until(() => gate.replicator.link === 'live' && gate.model.bases().length === 3, 10_000, 'boîte prête');
    key = gate.keys.create({ name: 'openapi', scopes: [{ target: 'all', read: true }, { target: 'base', storeId: stores[CLIENTS_DB]!, read: true, create: true, update: true, delete: true }, { target: 'files', deposit: true }], sql: true, mcp: true }).key;
    gate.state.data.queries.push({ id: '00000000-0000-4000-8000-000000000001', name: 'Par ville', slug: 'par-ville', sql: 'SELECT ville, count(*) AS n FROM clients GROUP BY ville', createdAt: '', updatedAt: '' });
  }, 60_000);

  afterAll(async () => {
    await gate?.stop();
    await mock?.close();
  });

  /** Une requête représentative de chaque opération décrite. */
  const calls: Record<string, () => Promise<Response>> = {
    health: () => fetch(`${api}/health`),
    metrics: () => fetch(`${api}/metrics`),
    openapi: () => fetch(`${api}/openapi.json`),
    docs: () => fetch(`${api}/docs`),
    mcp: () => post('/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    notify: () => fetch(`${api}/_filarr/notify`, { method: 'POST', headers: { 'Filarr-Notify': 't=1,v1=00' }, body: '{}' }),
    sql: () => post('/v1/sql', { sql: 'SELECT count(*) FROM clients' }),
    savedQuery: () => get('/v1/q/par-ville'),
    depositFile: () => fetch(`${api}/v1/files?name=essai.txt`, { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'text/plain' }, body: 'bonjour' }),
    depositStatus: () => get('/v1/files/dp_inconnu'),
    listRows: () => get('/v1/clients?statut=Client&sort=-ca&limit=1'),
    createRows: () => post('/v1/clients', { nom: 'OpenAPI SA' }),
    listRowsAlias: () => get('/v1/clients/rows'),
    createRowsAlias: () => post('/v1/clients/rows', [{ nom: 'Alias 1' }, { nom: 'Alias 2' }]),
    viewRows: () => get('/v1/clients/clients-actifs'),
    updateRowShort: () => fetch(`${api}/v1/clients/r_initech`, { method: 'PATCH', headers: h(), body: '{"ville":"Lille"}' }),
    deleteRowShort: () => fetch(`${api}/v1/clients/db-absente`, { method: 'DELETE', headers: h() }),
    getRow: () => get('/v1/clients/rows/r_acme'),
    updateRow: () => fetch(`${api}/v1/clients/rows/r_acme`, { method: 'PATCH', headers: h(), body: '{"ville":"Lyon"}' }),
    deleteRow: () => fetch(`${api}/v1/clients/rows/db-absente`, { method: 'DELETE', headers: h() }),
  };
  const h = () => ({ Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' });
  const get = (path: string) => fetch(`${api}${path}`, { headers: h() });
  const post = (path: string, body: unknown) => fetch(`${api}${path}`, { method: 'POST', headers: h(), body: JSON.stringify(body) });

  it('chaque opération décrite répond, avec un statut que la description prévoit', async () => {
    const operations = Object.values(spec.paths).flatMap((p) => Object.entries(p).filter(([m]) => m !== 'parameters').map(([, op]) => op));
    expect(operations.map((o) => o.operationId).sort()).toEqual(Object.keys(calls).sort());
    for (const op of operations) {
      const res = await calls[op.operationId]!();
      const allowed = Object.keys(op.responses);
      expect(allowed.includes(String(res.status)) || allowed.includes('default'), `${op.operationId} : ${res.status} n'est pas décrit (${allowed.join(', ')})`).toBe(true);
    }
  }, 60_000);

  it('les codes de refus décrits sont ceux que rend la boîte', async () => {
    const res = await get('/v1/clients?couleur=bleu');
    const body = (await res.json()) as { code: string; error: string; field: string };
    const errorSchema = (JSON.parse(readFileSync(join(__dirname, '..', 'docs', 'openapi', 'filarr-gate.v1.json'), 'utf8')) as { components: { schemas: { Error: { properties: { code: { examples: string[] } } } } } }).components.schemas.Error;
    expect(errorSchema.properties.code.examples).toContain(body.code);
    expect(body).toMatchObject({ code: 'unknown_field', field: 'couleur' });
  });
});
