/**
 * La description OpenAPI 3.1 de l'API locale, tirée des manifestes (bases, vues,
 * slugs) et des schémas (types des colonnes). Postman, n8n, Make et les
 * générateurs de bibliothèques la lisent telle quelle. Une page `/docs` la rend
 * lisible, sans rien charger d'ailleurs.
 */

import type { FieldDef } from './fields';
import type { BaseInfo } from './model';
import { viewFields } from './query';
import type { SavedQuery } from '../state';

type Schema = Record<string, unknown>;

function fieldSchema(f: FieldDef): Schema {
  const description = `${f.prop.name} (${f.prop.type})${f.writable ? '' : ' — calculé, en lecture seule'}`;
  switch (f.type) {
    case 'number':
      return { type: ['number', 'null'], description, ...(f.writable ? {} : { readOnly: true }) };
    case 'boolean':
      return { type: 'boolean', description };
    case 'date':
      return { type: ['string', 'null'], format: 'date', description };
    case 'datetime':
      return { type: ['string', 'null'], format: 'date-time', description, readOnly: true };
    case 'string[]':
      return {
        type: ['array', 'null'],
        items: f.options ? { type: 'string', enum: f.options } : { type: 'string' },
        description: f.prop.type === 'relation' ? `${description} — identifiants des lignes visées` : description,
        ...(f.writable ? {} : { readOnly: true }),
      };
    case 'object':
      return { type: ['object', 'null'], description };
    default:
      return {
        type: ['string', 'null'],
        ...(f.options ? { enum: [...f.options, null] } : {}),
        description,
        ...(f.writable ? {} : { readOnly: true }),
      };
  }
}

const componentName = (slug: string): string =>
  slug.split('-').map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join('') || 'Base';

const errorResponse = { $ref: '#/components/responses/Error' };

const listParams = [
  { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 1000, default: 100 } },
  { name: 'cursor', in: 'query', description: 'Le `next` de la page précédente.', schema: { type: 'string' } },
  { name: 'fields', in: 'query', description: 'Champs à rendre, séparés par des virgules.', schema: { type: 'string' } },
  { name: 'sort', in: 'query', description: 'Tri : `champ,-autre` (moins = décroissant).', schema: { type: 'string' } },
  { name: 'q', in: 'query', description: 'Recherche rapide dans le texte des lignes.', schema: { type: 'string' } },
  { name: 'since', in: 'query', description: 'Lignes changées depuis cette version (vue par cette boîte noire).', schema: { type: 'integer' } },
];

function pageSchema(ref: string): Schema {
  return {
    type: 'object',
    required: ['rows', 'next', 'total', 'version'],
    properties: {
      rows: { type: 'array', items: { $ref: ref } },
      next: { type: ['string', 'null'] },
      total: { type: 'integer' },
      version: { type: 'integer', description: 'Version (seq) du magasin servie.' },
      unresolved: { type: 'array', items: { type: 'string' }, description: 'Champs dont la base visée n’est pas ouverte à cet accès (contrat § 8).' },
    },
  };
}

export function buildOpenApi(opts: {
  bases: BaseInfo[];
  queries: SavedQuery[];
  serverUrl: string;
  version: string;
  write: boolean;
}): Record<string, unknown> {
  const paths: Record<string, unknown> = {};
  const schemas: Record<string, Schema> = {
    Error: {
      type: 'object',
      required: ['error', 'code'],
      properties: { error: { type: 'string' }, code: { type: 'string' } },
    },
  };
  for (const info of opts.bases) {
    const name = componentName(info.slug);
    const rowProps: Record<string, Schema> = { id: { type: 'string', readOnly: true } };
    for (const f of info.fields) rowProps[f.name] = fieldSchema(f);
    rowProps.created_at = { type: ['string', 'null'], format: 'date-time', readOnly: true };
    rowProps.updated_at = { type: ['string', 'null'], format: 'date-time', readOnly: true };
    schemas[name] = { type: 'object', title: info.title, required: ['id'], properties: rowProps };
    const inputProps: Record<string, Schema> = {};
    for (const f of info.fields.filter((x) => x.writable)) inputProps[f.name] = fieldSchema(f);
    schemas[`${name}Input`] = { type: 'object', additionalProperties: false, properties: inputProps };
    const ref = `#/components/schemas/${name}`;
    const writable = opts.write && info.rights === 'rw';
    const tag = info.title || info.slug;

    paths[`/v1/${info.slug}`] = {
      get: {
        tags: [tag],
        summary: `Lignes de ${info.title}`,
        operationId: `list_${info.slug.replace(/-/g, '_')}`,
        parameters: listParams,
        responses: { 200: { description: 'Une page de lignes', content: { 'application/json': { schema: pageSchema(ref) } } }, default: errorResponse },
      },
      ...(writable
        ? {
            post: {
              tags: [tag],
              summary: `Ajouter une ou plusieurs lignes à ${info.title}`,
              operationId: `create_${info.slug.replace(/-/g, '_')}`,
              parameters: [{ name: 'Idempotency-Key', in: 'header', schema: { type: 'string' } }],
              requestBody: {
                required: true,
                content: {
                  'application/json': {
                    schema: { oneOf: [{ $ref: `#/components/schemas/${name}Input` }, { type: 'array', items: { $ref: `#/components/schemas/${name}Input` } }] },
                  },
                },
              },
              responses: { 201: { description: 'Validé par Filarr' }, default: errorResponse },
            },
          }
        : {}),
    };
    paths[`/v1/${info.slug}/rows/{id}`] = {
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      get: {
        tags: [tag],
        summary: `Une ligne de ${info.title}`,
        operationId: `get_${info.slug.replace(/-/g, '_')}`,
        responses: { 200: { description: 'La ligne', content: { 'application/json': { schema: { $ref: ref } } } }, default: errorResponse },
      },
      ...(writable
        ? {
            patch: {
              tags: [tag],
              summary: `Modifier une ligne de ${info.title} (champ à null : vidé)`,
              operationId: `update_${info.slug.replace(/-/g, '_')}`,
              requestBody: { required: true, content: { 'application/json': { schema: { $ref: `#/components/schemas/${name}Input` } } } },
              responses: { 200: { description: 'Validé par Filarr' }, default: errorResponse },
            },
            delete: {
              tags: [tag],
              summary: `Supprimer une ligne de ${info.title}`,
              operationId: `delete_${info.slug.replace(/-/g, '_')}`,
              responses: { 200: { description: 'Validé par Filarr' }, default: errorResponse },
            },
          }
        : {}),
    };
    for (const v of info.views) {
      const isQuery = v.view.type === 'query';
      let schema: Schema;
      if (isQuery) {
        schema = { type: 'object', properties: { columns: { type: 'array', items: { type: 'string' } }, rows: { type: 'array', items: { type: 'object' } }, next: { type: ['string', 'null'] }, total: { type: 'integer' } } };
      } else {
        const visible = viewFields(info, v);
        const viewName = `${name}${componentName(v.slug)}`;
        const props: Record<string, Schema> = { id: { type: 'string' } };
        for (const f of visible) props[f.name] = fieldSchema(f);
        props.created_at = { type: ['string', 'null'], format: 'date-time' };
        props.updated_at = { type: ['string', 'null'], format: 'date-time' };
        schemas[viewName] = { type: 'object', title: `${info.title} · ${v.view.name}`, properties: props };
        schema = pageSchema(`#/components/schemas/${viewName}`);
      }
      paths[`/v1/${info.slug}/${v.slug}`] = {
        get: {
          tags: [tag],
          summary: `Vue « ${v.view.name} »${isQuery ? ' (requête SQL)' : ''}`,
          operationId: `view_${info.slug.replace(/-/g, '_')}_${v.slug.replace(/-/g, '_')}`,
          parameters: isQuery ? listParams.slice(0, 2) : listParams,
          responses: { 200: { description: 'La vue, rejouée par le moteur de Filarr', content: { 'application/json': { schema } } }, default: errorResponse },
        },
      };
    }
  }
  for (const q of opts.queries) {
    paths[`/v1/q/${q.slug}`] = {
      get: {
        tags: ['Requêtes enregistrées'],
        summary: q.name,
        operationId: `query_${q.slug.replace(/-/g, '_')}`,
        parameters: listParams.slice(0, 2),
        responses: { 200: { description: 'Le résultat de la requête' }, default: errorResponse },
      },
    };
  }
  paths['/v1/sql'] = {
    post: {
      tags: ['SQL'],
      summary: 'Une requête SELECT sur les bases que la clé peut lire (lecture seule)',
      operationId: 'run_sql',
      requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['sql'], properties: { sql: { type: 'string' } } } } } },
      responses: {
        200: {
          description: 'Le résultat',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  columns: { type: 'array', items: { type: 'string' } },
                  rows: { type: 'array', items: { type: 'array' } },
                  ms: { type: 'number' },
                  scanned: { type: 'integer' },
                  truncated: { type: 'boolean' },
                },
              },
            },
          },
        },
        default: errorResponse,
      },
    },
  };
  return {
    openapi: '3.1.0',
    info: {
      title: 'Filarr Gate',
      version: opts.version,
      description:
        'L’API locale de cette boîte noire : les bases Filarr ouvertes à son jeton, servies depuis sa copie déchiffrée en mémoire. Authentification : `Authorization: Bearer gk_…` (une clé d’application).',
      license: { name: 'Apache-2.0', identifier: 'Apache-2.0' },
    },
    servers: [{ url: opts.serverUrl }],
    security: [{ appKey: [] }],
    paths,
    components: {
      schemas,
      securitySchemes: { appKey: { type: 'http', scheme: 'bearer', description: 'Clé d’application `gk_…`' } },
      responses: { Error: { description: 'Refus ou erreur', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } } },
    },
  };
}

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** `/docs` : la description, lisible, sans rien charger d'ailleurs. */
export function docsHtml(spec: Record<string, unknown>): string {
  const paths = spec.paths as Record<string, Record<string, { summary?: string; parameters?: Array<{ name: string; in: string; description?: string }> }>>;
  const schemas = (spec.components as { schemas: Record<string, { title?: string; properties?: Record<string, { type?: unknown; description?: string; enum?: unknown[] }> }> }).schemas;
  let body = '';
  for (const [path, item] of Object.entries(paths)) {
    for (const [method, op] of Object.entries(item)) {
      if (method === 'parameters') continue;
      const params = (op.parameters ?? []).map((p) => `<li><code>${esc(p.name)}</code> <span class="in">${esc(p.in)}</span> ${esc(p.description ?? '')}</li>`).join('');
      body += `<section><h3><span class="m ${esc(method)}">${esc(method.toUpperCase())}</span> <code>${esc(path)}</code></h3><p>${esc(op.summary ?? '')}</p>${params ? `<ul>${params}</ul>` : ''}</section>`;
    }
  }
  let types = '';
  for (const [name, s] of Object.entries(schemas)) {
    if (!s.properties) continue;
    const rows = Object.entries(s.properties)
      .map(([k, v]) => `<tr><td><code>${esc(k)}</code></td><td>${esc(JSON.stringify(v.type ?? ''))}${v.enum ? ` · ${esc(v.enum.filter((x) => x !== null).join(', '))}` : ''}</td><td>${esc(v.description ?? '')}</td></tr>`)
      .join('');
    types += `<section><h3>${esc(s.title ?? name)} <code>${esc(name)}</code></h3><table><tbody>${rows}</tbody></table></section>`;
  }
  const info = spec.info as { title: string; version: string; description: string };
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(info.title)} · API</title>
<style>body{margin:0;font:14px/1.5 system-ui,sans-serif;color:#14233a;background:#f4f6f9}main{max-width:960px;margin:0 auto;padding:24px 16px 48px}h1{font-size:22px}section{background:#fff;border:1px solid #e1e7ef;border-radius:10px;padding:12px 16px;margin:10px 0}h3{margin:0 0 4px;font-size:14px}code{font-family:ui-monospace,monospace;font-size:12.5px}.m{display:inline-block;min-width:56px;font-size:11px;font-weight:700;padding:2px 6px;border-radius:6px;background:#e7eff9;color:#1d4f8a}.m.post{background:#e2f3e9;color:#1b7446}.m.patch{background:#fcefd9;color:#8f5200}.m.delete{background:#fce7e4;color:#b1261b}.in{color:#526276;font-size:12px}table{border-collapse:collapse;width:100%}td{border-top:1px solid #e1e7ef;padding:6px 8px;vertical-align:top}p{margin:4px 0;color:#526276}</style></head>
<body><main><h1>${esc(info.title)} <small>${esc(info.version)}</small></h1><p>${esc(info.description)}</p><p><a href="/openapi.json">openapi.json</a></p><h2>Points d’accès</h2>${body}<h2>Objets</h2>${types}</main></body></html>`;
}
