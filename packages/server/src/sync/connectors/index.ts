/** L'ouverture d'un connecteur selon la définition (§ 1). */

import { airtableConnector } from './airtable';
import { d1Connector, mysqlConnector, postgresConnector } from './drivers';
import { gsheetsConnector } from './gsheets';
import { notionConnector } from './notion';
import { supabaseConnector } from './supabase';
import { ConnectorError, type Connector, type ConnectorContext } from './types';
import { urlConnector } from './url';

export * from './types';

/** Les connecteurs que le moteur sait ouvrir (TCP : Node seulement). */
export const HTTPS_CONNECTORS = ['d1', 'supabase', 'airtable', 'gsheets', 'notion', 'url'] as const;

export async function openConnector(ctx: ConnectorContext, opts: { tcp: boolean }): Promise<Connector> {
  switch (ctx.def.connector) {
    case 'd1':
      return d1Connector(ctx);
    case 'supabase':
      return supabaseConnector(ctx);
    case 'airtable':
      return airtableConnector(ctx);
    case 'gsheets':
      return gsheetsConnector(ctx);
    case 'notion':
      return notionConnector(ctx);
    case 'url':
      return urlConnector(ctx);
    case 'postgres':
      if (!opts.tcp) throw new ConnectorError('extdb_unreachable', 'PostgreSQL ne se joint pas d’ici (connecteurs https seulement)');
      return postgresConnector(ctx);
    case 'mysql':
      if (!opts.tcp) throw new ConnectorError('extdb_unreachable', 'MySQL ne se joint pas d’ici (connecteurs https seulement)');
      return mysqlConnector(ctx);
    default:
      throw new ConnectorError('extdb_not_found', `connecteur inconnu : ${String(ctx.def.connector)}`);
  }
}
