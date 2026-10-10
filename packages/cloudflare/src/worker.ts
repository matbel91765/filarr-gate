/**
 * Filarr Gate sur VOTRE compte Cloudflare : un Worker, et un objet durable qui
 * tient la copie chiffrée, l'état, le journal et les ombres des synchros.
 *
 * - Le jeton est un secret du Worker (`npx wrangler secret put FILARR_GATE_TOKEN`) :
 *   ni Filarr ni personne d'autre que vous ne le lit.
 * - Pas de boucle : l'objet s'endort entre deux alarmes (relève toutes les
 *   `FILARR_GATE_POLL_SECONDS`, 300 s au moins) et se réveille aux réveils poussés
 *   de Filarr (`/_filarr/notify` : donnez l'adresse du Worker comme adresse de
 *   réveil de l'accès, dans Filarr).
 * - L'API locale est l'adresse du Worker ; l'interface de gestion vit sous
 *   `/admin/` (mot de passe : `npx wrangler secret put FILARR_GATE_ADMIN_PASSWORD`).
 * - Synchros externes : les connecteurs HTTPS (D1, Supabase, Airtable, Google
 *   Sheets, Notion, CSV/JSON par URL) ; PostgreSQL et MySQL demandent la version Node.
 */

import { DurableObject } from 'cloudflare:workers';
import { CloudflareGate, type GateEnv } from './host';

export interface Env extends GateEnv {
  GATE: DurableObjectNamespace<FilarrGate>;
  ASSETS?: Fetcher;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Une seule boîte par Worker : un seul objet, toujours le même
    return env.GATE.get(env.GATE.idFromName('filarr-gate')).fetch(request);
  },
} satisfies ExportedHandler<Env>;

export class FilarrGate extends DurableObject<Env> {
  private readonly gate: Promise<CloudflareGate>;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.gate = CloudflareGate.open(ctx, env);
    // La première copie se prépare sans bloquer les requêtes (l'API répond 503 « en préparation »)
    ctx.waitUntil(this.gate.then((g) => g.started).catch(() => undefined));
  }

  override async fetch(request: Request): Promise<Response> {
    const gate = await this.gate;
    try {
      return await gate.handle(request);
    } finally {
      this.ctx.waitUntil(gate.settle());
    }
  }

  override async alarm(): Promise<void> {
    const gate = await this.gate;
    await gate.onAlarm();
  }
}
