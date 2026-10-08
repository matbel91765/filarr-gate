/**
 * Le serveur MCP (Model Context Protocol) : un assistant IA lit les bases ouvertes,
 * en LECTURE SEULE, avec les droits de la clé d'application qui le connecte.
 *
 * - HTTP « streamable » : `POST /mcp` (JSON-RPC 2.0), réponses en JSON ;
 * - stdio : `filarr-gate mcp`, qui relaie ses messages vers `POST /mcp` d'une
 *   boîte noire en marche (une seule réplique, un seul compteur chez Filarr).
 *
 * Outils : `list_bases`, `query_view`, `get_row`, `run_sql`.
 */

import { randomUUID } from 'node:crypto';
import type { AppKeyRecord } from '../state';
import { canReadBase, canReadView } from './keys';
import type { GateModel } from './model';
import { ApiError, listRows, runSql, viewPage } from './query';
import { rowJson } from './fields';

export const MCP_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

type JsonRpcResponse =
  | { jsonrpc: '2.0'; id: string | number | null; result: unknown }
  | { jsonrpc: '2.0'; id: string | number | null; error: { code: number; message: string; data?: unknown } };

const TOOLS = [
  {
    name: 'list_bases',
    title: 'Bases ouvertes',
    description:
      'Liste les bases Filarr que cette boîte noire sert (celles que la clé peut lire), avec leurs champs JSON, leurs types et leurs vues.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'query_view',
    title: 'Lire une base ou une vue',
    description:
      'Rend les lignes d’une base (slug) ou d’une de ses vues (slug de vue), filtres, tri et colonnes de la vue appliqués par le moteur de Filarr. Pagination par `cursor`.',
    inputSchema: {
      type: 'object',
      required: ['base'],
      properties: {
        base: { type: 'string', description: 'Slug de la base' },
        view: { type: 'string', description: 'Slug de la vue (facultatif)' },
        limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
        cursor: { type: 'string' },
        search: { type: 'string', description: 'Recherche rapide dans le texte' },
        filters: { type: 'object', description: 'Filtres `champ` ou `champ[op]` (eq, ne, lt, lte, gt, gte, contains, in, empty) → valeur', additionalProperties: { type: 'string' } },
        sort: { type: 'string', description: '`champ,-autre`' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'get_row',
    title: 'Une ligne',
    description: 'Rend une ligne d’une base par son identifiant.',
    inputSchema: {
      type: 'object',
      required: ['base', 'id'],
      properties: { base: { type: 'string' }, id: { type: 'string' } },
      additionalProperties: false,
    },
  },
  {
    name: 'run_sql',
    title: 'Requête SQL',
    description:
      'Exécute une requête SELECT (dialecte SQLite) sur les bases que la clé peut lire, avec le moteur SQL de Filarr. Lecture seule : INSERT, UPDATE et DELETE sont refusés.',
    inputSchema: {
      type: 'object',
      required: ['sql'],
      properties: { sql: { type: 'string' } },
      additionalProperties: false,
    },
  },
];

export class McpServer {
  constructor(
    private readonly model: GateModel,
    private readonly version: string
  ) {}

  /** Traite un message (ou un lot) ; rend `null` pour une notification seule. */
  async handle(message: unknown, key: AppKeyRecord): Promise<{ body: unknown; sessionId?: string } | null> {
    if (Array.isArray(message)) {
      const out = (await Promise.all(message.map((m) => this.one(m, key)))).filter((r): r is JsonRpcResponse => r !== null);
      return out.length > 0 ? { body: out } : null;
    }
    const res = await this.one(message, key);
    if (!res) return null;
    const isInit = (message as JsonRpcRequest)?.method === 'initialize' && 'result' in res;
    return { body: res, ...(isInit ? { sessionId: randomUUID() } : {}) };
  }

  private async one(raw: unknown, key: AppKeyRecord): Promise<JsonRpcResponse | null> {
    const msg = raw as JsonRpcRequest;
    if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
      return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } };
    }
    const isNotification = msg.id === undefined;
    const id = msg.id ?? null;
    try {
      const result = await this.dispatch(msg, key);
      return isNotification ? null : { jsonrpc: '2.0', id, result };
    } catch (err) {
      if (isNotification) return null;
      if (err instanceof RpcError) return { jsonrpc: '2.0', id, error: { code: err.code, message: err.message } };
      return { jsonrpc: '2.0', id, error: { code: -32603, message: (err as Error).message } };
    }
  }

  private async dispatch(msg: JsonRpcRequest, key: AppKeyRecord): Promise<unknown> {
    switch (msg.method) {
      case 'initialize': {
        const asked = typeof msg.params?.protocolVersion === 'string' ? msg.params.protocolVersion : '';
        return {
          protocolVersion: MCP_PROTOCOL_VERSIONS.includes(asked) ? asked : MCP_PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'filarr-gate', title: 'Filarr Gate', version: this.version },
          instructions:
            'Bases Filarr déchiffrées par une boîte noire chez le client, en lecture seule. Commencez par list_bases, puis query_view ou run_sql.',
        };
      }
      case 'notifications/initialized':
      case 'notifications/cancelled':
        return {};
      case 'ping':
        return {};
      case 'tools/list':
        return { tools: TOOLS };
      case 'tools/call': {
        const name = msg.params?.name;
        const args = (msg.params?.arguments ?? {}) as Record<string, unknown>;
        if (typeof name !== 'string') throw new RpcError(-32602, 'Nom d’outil manquant');
        try {
          const data = this.call(name, args, key);
          return { content: [{ type: 'text', text: JSON.stringify(data, null, 1) }], structuredContent: data, isError: false };
        } catch (err) {
          if (err instanceof RpcError) throw err;
          const text = err instanceof ApiError ? `${err.code} : ${err.message}` : (err as Error).message;
          return { content: [{ type: 'text', text }], isError: true };
        }
      }
      default:
        throw new RpcError(-32601, `Méthode inconnue : ${msg.method}`);
    }
  }

  private call(name: string, args: Record<string, unknown>, key: AppKeyRecord): Record<string, unknown> {
    switch (name) {
      case 'list_bases':
        return {
          bases: this.model
            .bases()
            .filter((b) => canReadBase(key, b.storeId) || b.views.some((v) => canReadView(key, b.storeId, v.view.id)))
            .map((b) => ({
              slug: b.slug,
              title: b.title,
              version: b.version,
              rows: b.rows.length,
              fields: canReadBase(key, b.storeId) ? b.fields.map((f) => ({ name: f.name, column: f.prop.name, type: f.type, ...(f.options ? { options: f.options } : {}) })) : [],
              views: b.views.filter((v) => canReadView(key, b.storeId, v.view.id)).map((v) => ({ slug: v.slug, name: v.view.name, type: v.view.type })),
            })),
        };
      case 'query_view': {
        const info = this.model.base(String(args.base ?? ''));
        if (!info) throw new ApiError(404, 'base_not_found', `Base inconnue : ${String(args.base)}`);
        const params = new URLSearchParams();
        params.set('limit', String(Math.min(200, Number(args.limit ?? 50) || 50)));
        if (typeof args.cursor === 'string') params.set('cursor', args.cursor);
        if (typeof args.search === 'string') params.set('q', args.search);
        if (typeof args.sort === 'string') params.set('sort', args.sort);
        if (args.filters && typeof args.filters === 'object') for (const [k, v] of Object.entries(args.filters)) params.set(k, String(v));
        if (typeof args.view === 'string' && args.view !== '') {
          const view = info.views.find((v) => v.slug === args.view);
          if (!view) throw new ApiError(404, 'view_not_found', `Vue inconnue : ${args.view}`);
          if (!canReadView(key, info.storeId, view.view.id)) throw new ApiError(403, 'forbidden', 'Cette clé ne lit pas cette vue');
          return { ...viewPage(this.model, info, view, params) };
        }
        if (!canReadBase(key, info.storeId)) throw new ApiError(403, 'forbidden', 'Cette clé ne lit pas cette base');
        return { ...listRows(this.model, info, params) };
      }
      case 'get_row': {
        const info = this.model.base(String(args.base ?? ''));
        if (!info) throw new ApiError(404, 'base_not_found', `Base inconnue : ${String(args.base)}`);
        if (!canReadBase(key, info.storeId)) throw new ApiError(403, 'forbidden', 'Cette clé ne lit pas cette base');
        const row = info.base.mirror.rowById(String(args.id ?? ''));
        if (!row) throw new ApiError(404, 'row_not_found', 'Ligne introuvable');
        return { row: rowJson(info.fields, row, this.model.env(info)), version: info.version };
      }
      case 'run_sql': {
        if (!key.sql) throw new ApiError(403, 'forbidden', 'Cette clé n’a pas le droit SQL');
        const readable = new Set(this.model.bases().filter((b) => canReadBase(key, b.storeId)).map((b) => b.storeId));
        return { ...runSql(this.model.sql(readable).catalog, String(args.sql ?? '')) };
      }
      default:
        throw new RpcError(-32602, `Outil inconnu : ${name}`);
    }
  }
}

class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string
  ) {
    super(message);
  }
}
