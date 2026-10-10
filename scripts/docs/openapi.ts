/**
 * La description GÉNÉRIQUE de l'API locale de Filarr Gate (OpenAPI 3.1) : les routes que sert
 * toute boîte, quelles que soient ses bases. Chaque boîte sert aussi sa description EXACTE à
 * `/openapi.json` (ses bases, colonnes typées, vues et requêtes enregistrées).
 *
 * Bâtie avec les constantes et les listes de codes du code lui-même, écrite dans
 * `docs/openapi/filarr-gate.v1.json` par `npm run docs`, et éprouvée route par route contre une
 * boîte en marche par `test/docs.test.ts`.
 */

import { MAX_JSON_BODY } from '../../packages/server/src/http';
import { DEFAULT_LIMIT, MAX_LIMIT, SQL_MAX_ROWS } from '../../packages/gate/src/data/query';
import { MAX_FILE_BYTES, MAX_TAGS, MAX_TAG_LENGTH } from '../../packages/core/src/engine/gate/files';
import { MCP_PROTOCOL_VERSIONS } from '../../packages/server/src/api/mcp';

type Obj = Record<string, unknown>;

const OPERATORS = ['eq', 'ne', 'lt', 'lte', 'gt', 'gte', 'contains', 'in', 'empty'];

const ref = (name: string): Obj => ({ $ref: `#/components/schemas/${name}` });
const json = (schema: Obj, description: string): Obj => ({ description, content: { 'application/json': { schema } } });
const err = (description: string): Obj => ({ description, content: { 'application/json': { schema: ref('Error') } } });

export function genericOpenApi(errorCodes: string[]): Obj {
  const listParams: Obj[] = [
    { name: 'limit', in: 'query', description: `Rows per page, ${DEFAULT_LIMIT} by default, ${MAX_LIMIT} at most (a larger number is served as ${MAX_LIMIT}).`, schema: { type: 'integer', minimum: 1, default: DEFAULT_LIMIT } },
    { name: 'cursor', in: 'query', description: 'The `next` of the previous page, as received.', schema: { type: 'string' } },
    { name: 'fields', in: 'query', description: 'Fields to return, separated by commas (`id` is always returned).', schema: { type: 'string' }, example: 'nom,ville' },
    { name: 'sort', in: 'query', description: 'Sort keys separated by commas; a leading `-` sorts in descending order. Empty values sort last.', schema: { type: 'string' }, example: '-ca,nom' },
    { name: 'q', in: 'query', description: 'Quick search in the text of the rows (the same search as in Filarr).', schema: { type: 'string' } },
    { name: 'since', in: 'query', description: 'Only the rows changed after this version (the `version` of a page you already read).', schema: { type: 'integer', minimum: 0 } },
    {
      name: 'filters',
      in: 'query',
      style: 'form',
      explode: true,
      description: `Any other parameter is a filter: \`field=value\` (equals) or \`field[op]=value\` with op in ${OPERATORS.map((o) => `\`${o}\``).join(', ')}. Filters combine with AND. \`in\` takes values separated by commas; \`empty=true\` or \`empty=false\`. Texts compare without case or accents.`,
      schema: { type: 'object', additionalProperties: { type: 'string' } },
      example: { statut: 'Client', 'ca[gte]': '1000' },
    },
  ];
  const pageParams = [listParams[0], listParams[1]];
  const idemHeader = { name: 'Idempotency-Key', in: 'header', description: 'Any unique string: the same request sent again with the same key (same app key, method and path) within 24 hours returns the first answer, with `Idempotency-Replayed: true`, and writes nothing twice. Kept in memory: a restart forgets it.', schema: { type: 'string' } };
  const baseParam = { name: 'base', in: 'path', required: true, description: 'The slug of the database (fixed by Filarr when the database was opened to the access; renaming the database does not change it).', schema: { type: 'string' } };
  const versionHeader = { 'X-Filarr-Version': { description: 'The version (`seq`) of the database served.', schema: { type: 'integer' } } };
  const baseStatusHeader = { 'X-Gate-Base-Status': { description: 'Present when the database is served from its last complete copy while something is wrong (for instance `missing_key`).', schema: { type: 'string' } } };
  const readHeaders = { ...versionHeader, ...baseStatusHeader };
  const writeResponses = (ok: Obj): Obj => ({
    ...ok,
    400: err('Invalid body or field (`bad_body`, `unknown_field`, `bad_value`, `unknown_option`, `field_read_only`)'),
    401: err('No app key, or an unknown one'),
    403: err('Write refused: `write_disabled`, `filarr_write_unavailable`, `base_read_only`, `forbidden`, or a Filarr refusal'),
    404: err('Unknown database or row'),
    409: err('`field_managed`, `rows_managed`, `key_missing` (the gate lacks the key of the current generation), `vault_frozen`'),
    413: err('More than 500 rows, or a body over the limit'),
    429: { ...err('The key\'s rate limit, or a Filarr limit (`api_quota_writes`, `api_rate`); `Retry-After` gives the seconds to wait'), headers: { 'Retry-After': { schema: { type: 'integer' } } } },
    503: err('Filarr unreachable: nothing was written; or the database is not loaded yet'),
  });

  return {
    openapi: '3.1.0',
    info: {
      title: 'Filarr Gate local API',
      version: 'v1',
      summary: 'The routes every Filarr Gate serves from its decrypted copy of the Filarr databases opened to it.',
      description:
        'This is the GENERIC description: it holds for every gate. A running gate serves its EXACT description at `/openapi.json` (its databases, their typed fields, its views and saved queries), which is what client generators should read. Every call to `/v1/*` carries an app key (`Authorization: Bearer gk_…`); the Filarr token never leaves the gate. Errors are `{ "error": "<message>", "code": "<code>" }` plus details; match on `code`, the message is for people. See docs/reference/api.md and docs/reference/errors.md in the repository.',
      license: { name: 'Apache-2.0', identifier: 'Apache-2.0' },
    },
    servers: [{ url: 'http://127.0.0.1:8443', description: 'A gate on this machine, default port' }],
    security: [{ appKey: [] }],
    tags: [
      { name: 'Rows', description: 'Read and write the rows of a database' },
      { name: 'Views', description: 'A view of a database, replayed by Filarr\'s own view engine' },
      { name: 'SQL', description: 'Read-only SQL over the opened databases' },
      { name: 'Files', description: 'Deposit files into the deposit box linked to the access' },
      { name: 'Gate', description: 'Health, metrics, descriptions, MCP, Filarr\'s wake-ups' },
    ],
    paths: {
      '/health': {
        get: {
          tags: ['Gate'],
          operationId: 'health',
          summary: 'Health of the gate (no key)',
          security: [],
          responses: { 200: json(ref('Health'), '`ok` when the link with Filarr is up and every database is ready, `degraded` otherwise') },
        },
      },
      '/metrics': {
        get: {
          tags: ['Gate'],
          operationId: 'metrics',
          summary: 'Prometheus metrics (no key; the `metrics` setting, on by default)',
          security: [],
          responses: { 200: { description: 'Prometheus text format', content: { 'text/plain': { schema: { type: 'string' } } } }, 404: err('Metrics switched off') },
        },
      },
      '/openapi.json': {
        get: {
          tags: ['Gate'],
          operationId: 'openapi',
          summary: 'The exact description of THIS gate (public when the `docs` setting is on, the default; otherwise with a key)',
          security: [{}, { appKey: [] }],
          responses: { 200: json({ type: 'object' }, 'OpenAPI 3.1 of this gate'), 401: err('`docs` is off and no key was given') },
        },
      },
      '/docs': {
        get: {
          tags: ['Gate'],
          operationId: 'docs',
          summary: 'The same description, as a readable page',
          security: [{}, { appKey: [] }],
          responses: { 200: { description: 'HTML page', content: { 'text/html': { schema: { type: 'string' } } } }, 401: err('`docs` is off and no key was given') },
        },
      },
      '/mcp': {
        post: {
          tags: ['Gate'],
          operationId: 'mcp',
          summary: 'Model Context Protocol server (JSON-RPC 2.0, streamable HTTP, JSON answers), read only',
          description: `The \`mcp\` setting must be on (off by default) and the key needs the MCP right. Protocol versions: ${MCP_PROTOCOL_VERSIONS.join(', ')}. Tools: \`list_bases\`, \`query_view\`, \`get_row\`, \`run_sql\` (the last one needs the SQL right too). See docs/reference/mcp.md.`,
          requestBody: { required: true, content: { 'application/json': { schema: { type: ['object', 'array'] } } } },
          responses: {
            200: { description: 'JSON-RPC answer; `Mcp-Session-Id` on `initialize`', headers: { 'Mcp-Session-Id': { schema: { type: 'string' } } }, content: { 'application/json': { schema: { type: ['object', 'array'] } } } },
            202: { description: 'A notification: no answer' },
            401: err('No app key, or an unknown one'),
            403: err('The key has no MCP right'),
            404: err('MCP switched off'),
            405: err('Only POST'),
          },
        },
      },
      '/_filarr/notify': {
        post: {
          tags: ['Gate'],
          operationId: 'notify',
          summary: 'Push wake-up from Filarr (not for your software)',
          description: 'Filarr posts `{ "a", "t", "storeId"?, "seq"?, "at" }` signed `Filarr-Notify: t=<seconds>,v1=<HMAC-SHA256 hex>` with a key derived from the token. The gate checks the signature on the raw body and a 300-second window, answers 202, and re-reads through its usual routes: a wake-up carries no content.',
          security: [],
          parameters: [{ name: 'Filarr-Notify', in: 'header', required: true, schema: { type: 'string' } }],
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object' } } } },
          responses: {
            202: json({ type: 'object' }, 'Accepted; the gate re-reads'),
            400: err('`notify_malformed`'),
            401: err('`notify_bad_signature`, `notify_stale`, `notify_malformed`'),
            404: err('Wake-ups switched off (`notify`)'),
            413: err('Body over 8 KiB'),
            503: err('No token in service'),
          },
        },
      },
      '/v1/sql': {
        post: {
          tags: ['SQL'],
          operationId: 'sql',
          summary: 'A read-only SQL query (SQLite dialect) over the databases the key can read',
          description: `The key needs the SQL right. Only \`SELECT\` and \`WITH … SELECT\`. The tables are those of Filarr's Query view: one per database, named after its title (lower case, no accents, \`_\` between words), one column per column of the database (computed columns left out), a single relation as a foreign key \`<relation>_id\`, a multiple one as a junction table; a database that is not opened appears with its \`id\` only. At most ${SQL_MAX_ROWS} rows are returned (\`truncated\` says when there were more); queries of 64 KiB at most.`,
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['sql'], properties: { sql: { type: 'string' } } }, example: { sql: 'SELECT ville, count(*) AS n FROM clients GROUP BY ville' } } } },
          responses: {
            200: json(ref('SqlResult'), 'Columns and rows (arrays, in column order)'),
            400: err('`sql_empty`, `sql_syntax` (with `position`), `sql_error` (with `sqlCode`), `sql_read_only`'),
            401: err('No app key, or an unknown one'),
            403: err('The key has no SQL right'),
            413: err('Query over 64 KiB'),
          },
        },
      },
      '/v1/q/{query}': {
        get: {
          tags: ['SQL'],
          operationId: 'savedQuery',
          summary: 'Run a saved query (saved in the management UI), rows as objects, paginated',
          parameters: [{ name: 'query', in: 'path', required: true, description: 'The slug of the saved query', schema: { type: 'string' } }, ...pageParams],
          responses: {
            200: json(ref('QueryPage'), 'A page of the query\'s rows'),
            401: err('No app key, or an unknown one'),
            403: err('The key cannot run this query'),
            404: err('`query_not_found`'),
          },
        },
      },
      '/v1/files': {
        post: {
          tags: ['Files'],
          operationId: 'depositFile',
          summary: 'Deposit a file into the deposit box linked to the access; the Filarr app files it',
          description: `The key needs the \`files\` scope. The gate filters first (executables and scripts by extension and by signature, size up to the limit Filarr gives and never above ${MAX_FILE_BYTES} bytes), then seals the file for the box, sends it in chunks, and returns at once. Neither Filarr nor the gate learns where the file is filed. Send \`multipart/form-data\` with a \`file\` part (and optional \`path\`, \`tags\`, \`name\`), or the raw bytes with \`?name=\` (or an \`X-File-Name\` header), \`&path=\` and \`&tags=\`. Tags: ${MAX_TAGS} at most, ${MAX_TAG_LENGTH} characters each.`,
          parameters: [
            { name: 'name', in: 'query', description: 'Raw body only: the file name, with its extension', schema: { type: 'string' } },
            { name: 'path', in: 'query', description: 'Raw body only: the path requested inside the target folder (the Filarr app applies it if the box accepts requested paths)', schema: { type: 'string' } },
            { name: 'tags', in: 'query', description: 'Raw body only: tags, repeated or separated by commas', schema: { type: 'string' } },
          ],
          requestBody: {
            required: true,
            content: {
              'multipart/form-data': {
                schema: {
                  type: 'object',
                  required: ['file'],
                  properties: { file: { type: 'string', format: 'binary' }, path: { type: 'string' }, tags: { type: 'string', description: 'Repeated, or separated by commas' }, name: { type: 'string', description: 'Overrides the file name of the part' } },
                },
              },
              'application/octet-stream': { schema: { type: 'string', format: 'binary' } },
            },
          },
          responses: {
            202: json(ref('Deposit'), 'Deposited: Filarr holds the sealed file until a device of the owner files it'),
            400: err('`file_required`, `name_required`, `bad_tags`, `bad_path`, `bad_multipart`'),
            401: err('No app key, or an unknown one'),
            403: err('`scope_files`, or a Filarr refusal (`api_tier_files`)'),
            404: err('`box_not_found`'),
            409: err('`files_not_linked`, `box_not_signed`, `creator_unauthenticated`, `box_full`, `files_not_switched`, `box_not_permanent`'),
            413: { ...err('`file_too_large` (with `limit`), `box_storage_full`'), content: { 'application/json': { schema: ref('Error') } } },
            415: err('`file_type_refused` (with `reason` and `detail`)'),
            429: { ...err('Filarr\'s monthly file quotas (`api_quota_files`, `api_quota_file_bytes`) or rate; `Retry-After`'), headers: { 'Retry-After': { schema: { type: 'integer' } } } },
            503: err('Filarr unreachable: nothing was deposited'),
          },
        },
      },
      '/v1/files/{id}': {
        get: {
          tags: ['Files'],
          operationId: 'depositStatus',
          summary: 'The status of a deposit (never where or under which name it was filed)',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' }, description: 'The `id` returned by `POST /v1/files` (`dp_…`)' }],
          responses: { 200: json(ref('DepositStatus'), 'The status, re-read from Filarr while it is `deposited`'), 401: err('No app key, or an unknown one'), 403: err('`scope_files`'), 404: err('`deposit_not_found`') },
        },
      },
      '/v1/{base}': {
        parameters: [baseParam],
        get: {
          tags: ['Rows'],
          operationId: 'listRows',
          summary: 'The rows of a database: filters, sort, fields, search, pagination',
          parameters: listParams,
          responses: {
            200: { ...json(ref('Page'), 'A page of rows'), headers: readHeaders },
            400: err('`bad_filter`, `unknown_field` (with `field`), `bad_limit`, `bad_cursor`, `bad_since`'),
            401: err('No app key, or an unknown one'),
            403: err('`forbidden`, `key_paused`, `key_expired`, `ip_forbidden`, `origin_forbidden`'),
            404: err('`base_not_found`'),
            429: { ...err('`key_rate`; `Retry-After`'), headers: { 'Retry-After': { schema: { type: 'integer' } } } },
            503: err('The database is not loaded yet, or not served (`code` says why: `base_loading`, `key_missing`…)'),
          },
        },
        post: {
          tags: ['Rows'],
          operationId: 'createRows',
          summary: 'Create one row (an object) or several (an array, 500 at most): one commit in Filarr',
          description: 'Writing needs the `write` setting of the gate (off by default), a `rw` right from Filarr, and an app key with the create right on this database. A new row gets the default values of its columns, as "New row" does in Filarr; a field given as `null` stays empty.',
          parameters: [idemHeader],
          requestBody: { required: true, content: { 'application/json': { schema: { oneOf: [ref('RowInput'), { type: 'array', items: ref('RowInput'), maxItems: 500 }] } } } },
          responses: writeResponses({ 201: { ...json(ref('Created'), 'Accepted by Filarr'), headers: { ...versionHeader, 'Idempotency-Replayed': { schema: { type: 'string' } } } } }),
        },
      },
      '/v1/{base}/rows': {
        parameters: [baseParam],
        get: { tags: ['Rows'], operationId: 'listRowsAlias', summary: 'Same as `GET /v1/{base}`', parameters: listParams, responses: { 200: json(ref('Page'), 'A page of rows'), default: err('As `GET /v1/{base}`') } },
        post: { tags: ['Rows'], operationId: 'createRowsAlias', summary: 'Same as `POST /v1/{base}`', parameters: [idemHeader], requestBody: { required: true, content: { 'application/json': { schema: { oneOf: [ref('RowInput'), { type: 'array', items: ref('RowInput') }] } } } }, responses: writeResponses({ 201: json(ref('Created'), 'Accepted by Filarr') }) },
      },
      '/v1/{base}/{view}': {
        parameters: [baseParam, { name: 'view', in: 'path', required: true, description: 'The slug of the view (fixed when the database was opened; renaming the view does not change it)', schema: { type: 'string' } }],
        get: {
          tags: ['Views'],
          operationId: 'viewRows',
          summary: 'A view, replayed by Filarr\'s view engine: its filters, sort and visible columns',
          description: 'The query parameters of `GET /v1/{base}` apply too, AFTER the view\'s own filters and on its visible fields. A Query view (SQL) returns its result as objects and takes `limit` and `cursor` only.',
          parameters: listParams,
          responses: {
            200: { ...json(ref('ViewPage'), 'A page of the view\'s rows'), headers: readHeaders },
            400: err('As `GET /v1/{base}`'),
            401: err('No app key, or an unknown one'),
            403: err('The key cannot read this view'),
            404: err('`base_not_found`, `view_not_found`'),
            503: err('The database is not loaded yet'),
          },
        },
        patch: { tags: ['Rows'], operationId: 'updateRowShort', summary: 'Same as `PATCH /v1/{base}/rows/{id}` (here `{view}` is the row id)', parameters: [idemHeader], requestBody: { required: true, content: { 'application/json': { schema: ref('RowInput') } } }, responses: writeResponses({ 200: json(ref('Updated'), 'Accepted by Filarr') }) },
        delete: { tags: ['Rows'], operationId: 'deleteRowShort', summary: 'Same as `DELETE /v1/{base}/rows/{id}` (here `{view}` is the row id)', parameters: [idemHeader], responses: writeResponses({ 200: json(ref('Deleted'), 'Accepted by Filarr') }) },
      },
      '/v1/{base}/rows/{id}': {
        parameters: [baseParam, { name: 'id', in: 'path', required: true, description: 'The row\'s identifier (`db-…`, or `ext-…` for a row created by an external sync)', schema: { type: 'string' } }],
        get: {
          tags: ['Rows'],
          operationId: 'getRow',
          summary: 'One row',
          responses: { 200: { ...json(ref('OneRow'), 'The row'), headers: readHeaders }, 401: err('No app key, or an unknown one'), 403: err('The key cannot read this database'), 404: err('`base_not_found`, `row_not_found`') },
        },
        patch: {
          tags: ['Rows'],
          operationId: 'updateRow',
          summary: 'Change some fields of a row (the others are untouched); `null` empties a field',
          parameters: [idemHeader],
          requestBody: { required: true, content: { 'application/json': { schema: ref('RowInput') } } },
          responses: writeResponses({ 200: json(ref('Updated'), 'Accepted by Filarr') }),
        },
        delete: {
          tags: ['Rows'],
          operationId: 'deleteRow',
          summary: 'Delete a row (it can be restored in Filarr)',
          parameters: [idemHeader],
          responses: writeResponses({ 200: json(ref('Deleted'), 'Accepted by Filarr') }),
        },
      },
    },
    components: {
      securitySchemes: {
        appKey: { type: 'http', scheme: 'bearer', bearerFormat: 'gk_…', description: 'An app key created on the gate (management UI or `filarr-gate keys create`). `X-Gate-Key: gk_…` works too. Never the Filarr token.' },
      },
      schemas: {
        Row: {
          type: 'object',
          required: ['id', 'created_at', 'updated_at'],
          properties: { id: { type: 'string' }, created_at: { type: ['string', 'null'], format: 'date-time' }, updated_at: { type: ['string', 'null'], format: 'date-time' } },
          additionalProperties: true,
          description: 'One field per column, named after the column (lower case, no accents, `_` between words; `Dernier contact` → `dernier_contact`). A select gives the option\'s label, a relation the raw ids of the linked rows, a rollup its value (`null` when its database is not opened). The exact fields of each database are in the gate\'s own `/openapi.json`.',
        },
        RowInput: { type: 'object', additionalProperties: true, description: 'The fields to write, by their JSON name; `null` empties a field. `id`, `created_at` and `updated_at` are ignored. Select fields take an option label.' },
        Page: {
          type: 'object',
          required: ['rows', 'next', 'total', 'version'],
          properties: {
            rows: { type: 'array', items: ref('Row') },
            next: { type: ['string', 'null'], description: 'The cursor of the next page, or `null`' },
            total: { type: 'integer', description: 'Rows that match, all pages together' },
            version: { type: 'integer', description: 'The version (`seq`) of the database served' },
            unresolved: { type: 'array', items: { type: 'string' }, description: 'Fields whose linked database is not opened to this access' },
          },
        },
        ViewPage: { allOf: [ref('Page'), { type: 'object', properties: { view: { type: 'object', properties: { slug: { type: 'string' }, name: { type: 'string' } } }, columns: { type: 'array', items: { type: 'string' }, description: 'Query views only' } } }] },
        QueryPage: {
          type: 'object',
          required: ['columns', 'rows', 'next', 'total'],
          properties: { columns: { type: 'array', items: { type: 'string' } }, rows: { type: 'array', items: { type: 'object' } }, next: { type: ['string', 'null'] }, total: { type: 'integer' }, query: { type: 'object', properties: { slug: { type: 'string' }, name: { type: 'string' } } }, ms: { type: 'number' } },
        },
        SqlResult: {
          type: 'object',
          required: ['columns', 'rows', 'ms', 'scanned', 'truncated'],
          properties: {
            columns: { type: 'array', items: { type: 'string' } },
            rows: { type: 'array', items: { type: 'array', items: {} } },
            ms: { type: 'number' },
            scanned: { type: 'integer', description: 'Rows read from the tables named by the query' },
            truncated: { type: 'boolean', description: `More than ${SQL_MAX_ROWS} rows: only the first ones are returned` },
          },
        },
        OneRow: { type: 'object', required: ['row', 'version'], properties: { row: ref('Row'), version: { type: 'integer' }, unresolved: { type: 'array', items: { type: 'string' } } } },
        Created: {
          type: 'object',
          required: ['version', 'validated'],
          properties: { id: { type: 'string' }, row: ref('Row'), rows: { type: 'array', items: ref('Row'), description: 'When an array was sent' }, version: { type: 'integer' }, validated: { const: true } },
        },
        Updated: { type: 'object', required: ['id', 'row', 'version', 'validated'], properties: { id: { type: 'string' }, row: ref('Row'), version: { type: 'integer' }, validated: { const: true } } },
        Deleted: { type: 'object', required: ['id', 'deleted', 'version', 'validated'], properties: { id: { type: 'string' }, deleted: { const: true }, version: { type: 'integer' }, validated: { const: true } } },
        Deposit: { type: 'object', required: ['id', 'status'], properties: { id: { type: 'string', description: '`dp_…`, this gate\'s identifier' }, status: { const: 'deposited' }, depositedAt: { type: ['string', 'null'], format: 'date-time' }, seq: { type: 'integer', description: 'Number of the deposit in the month, for this box' } } },
        DepositStatus: {
          type: 'object',
          required: ['id', 'status'],
          properties: { id: { type: 'string' }, status: { enum: ['sending', 'deposited', 'filed', 'rejected', 'expired', 'failed'] }, depositedAt: { type: ['string', 'null'], format: 'date-time' }, filedAt: { type: ['string', 'null'], format: 'date-time' } },
        },
        Health: {
          type: 'object',
          required: ['status', 'link', 'version', 'bases'],
          properties: {
            status: { enum: ['ok', 'degraded'] },
            link: { type: 'string', description: 'The state of the link with Filarr (see docs/reference/errors.md, link states)' },
            version: { type: 'string' },
            bases: { type: 'array', items: { type: 'object', properties: { slug: { type: ['string', 'null'] }, status: { type: 'string' }, version: { type: 'integer' } } } },
          },
        },
        Error: {
          type: 'object',
          required: ['error', 'code'],
          properties: {
            error: { type: 'string', description: 'A message for people (it may change; match on `code`)' },
            code: { type: 'string', description: 'A stable code. The local API\'s own codes are listed here; codes passed on from Filarr keep Filarr\'s name.', examples: errorCodes },
            retryAfter: { type: 'integer', description: '429: seconds to wait (also in `Retry-After`)' },
            field: { type: 'string', description: 'The field concerned' },
            limit: { type: 'integer', description: '`file_too_large`: the size allowed, in bytes' },
            keys: { type: 'array', items: { type: 'object' }, description: '`key_missing`: the `(e, g)` couples missing' },
            position: { type: 'integer', description: '`sql_syntax`: where parsing failed' },
            sqlCode: { type: 'string' },
            reason: { type: 'string', description: '`file_type_refused`: `extension`, `signature`…' },
            detail: { type: 'string' },
          },
        },
      },
    },
    'x-limits': { maxJsonBodyBytes: MAX_JSON_BODY, maxRowsPerCreate: 500, maxLimit: MAX_LIMIT, sqlMaxRows: SQL_MAX_ROWS, maxFileBytes: MAX_FILE_BYTES },
  };
}
