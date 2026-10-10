/**
 * LE WORKER DEVANT LES BOÎTES — route `*.gate.filarr.com/*` (contrat `gate-heberge-1` § 2.0.1, § 2.3, § 6.3).
 *
 *  - `ctl.<domaine>` : l'adresse de CONTRÔLE, stable, qui ne dépend d'aucune boîte (aucun `hostName`
 *    ne peut valoir `ctl` : il porte toujours un suffixe). Elle reçoit les réveils
 *    (`POST /_filarr/notify/<accessId>`) et les répartit vers l'objet de la boîte ; elle sert aussi
 *    l'annonce de version et `/health` du service ;
 *  - `<hostName>.<domaine>` : l'API d'une boîte (`/v1/*`, `/openapi.json`, `/mcp`, `/health`) et son
 *    canal de gestion signé (`/_admin/*`). Un nom inconnu reçoit `404` ; une boîte effacée par une
 *    migration avec redirection répond `308` vers la nouvelle adresse pendant 30 jours, sans lire
 *    ni garder la requête.
 *
 * Le Worker ne lit aucun corps et ne garde rien : il choisit l'objet et lui passe la requête, avec
 * trois en-têtes internes qu'il pose lui-même (ceux d'un client sont retirés).
 */

import { slugBase } from '../../core/src/engine/store/apiAccess';
import { INTERNAL } from './box';
import type { DirectoryClient, DirectoryEntry } from './directory';
import { appOriginOf, CONTROL_LABEL, domainOf, HOST_VERSION, type HostEnv } from './env';
import { corsHeaders, json, notFound, withHeaders } from './http';
import { loadKeyring, type HostKeyring } from './keys';
import { announcement } from './version';

export const HOST_NAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,29})-[a-z0-9]{4}$/;
const ACCESS_ID_RE = /^[A-Za-z0-9_-]{22}$/;
const WELL_KNOWN = '/.well-known/filarr-gate-host.json';

export interface FrontDeps {
  directory: Pick<DirectoryClient, 'lookup'>;
  /** Le talon de l'objet d'une boîte (juridiction UE). */
  box(accessId: string): { fetch(request: Request): Promise<Response> };
  now?: () => number;
  ring?: HostKeyring;
  /** Le cache de l'annuaire dans l'isolat (d'office) ; les essais le coupent. */
  cache?: boolean;
}

/**
 * La partie lisible d'un `hostName` (§ 6.3, famille 7) : le slug d'api-base-1 § 4 coupé à 30 caractères
 * (vide → `base`). C'est l'API qui tire le nom et son suffixe aléatoire ; le service ne fait que
 * reconnaître la forme `<slug>-<4 caractères base36>`.
 */
export function hostNameBase(accessName: string): string {
  const slug = slugBase(accessName, 'base').slice(0, 30).replace(/-+$/, '');
  return slug === '' ? 'base' : slug;
}

/** `ctl`, un `hostName` valide, ou `null` (hors du domaine, plusieurs niveaux, nom invalide). */
export function labelOf(hostname: string, domain: string): string | null {
  const h = hostname.toLowerCase().replace(/\.$/, '');
  const suffix = `.${domain}`;
  if (!h.endsWith(suffix)) return null;
  const label = h.slice(0, -suffix.length);
  if (label === CONTROL_LABEL) return label;
  return HOST_NAME_RE.test(label) ? label : null;
}

/**
 * Le cache de l'annuaire dans l'isolat : 60 s pour un nom connu, 3 s pour un inconnu (une boîte qui
 * vient de naître répond dans les secondes qui suivent : A2 attend `/health`).
 */
const cache = new Map<string, { entry: DirectoryEntry | null; until: number }>();

export function clearFrontCache(): void {
  cache.clear();
}

async function lookup(deps: FrontDeps, hostName: string, now: number): Promise<DirectoryEntry | null> {
  if (deps.cache === false) return deps.directory.lookup(hostName);
  const hit = cache.get(hostName);
  if (hit && hit.until > now) return hit.entry;
  const entry = await deps.directory.lookup(hostName);
  if (cache.size > 10_000) cache.clear();
  cache.set(hostName, { entry, until: now + (entry && !entry.erased ? 60_000 : 3_000) });
  return entry;
}

/** La requête telle que l'objet la reçoit : en-têtes internes posés ici, jamais ceux du client. */
function forward(request: Request, headers: Record<string, string>): Request {
  const h = new Headers(request.headers);
  for (const name of [...Object.values(INTERNAL), 'x-gate-cli', 'x-gate-admin']) h.delete(name);
  for (const [k, v] of Object.entries(headers)) h.set(k, v);
  return new Request(request, { headers: h });
}

function wellKnown(env: HostEnv, ring: HostKeyring, now: number): Response {
  const a = announcement(env, ring, now);
  if (!a) return json(503, { error: 'This service was not deployed by the release chain', code: 'not_deployed' });
  return json(200, a, { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, max-age=60' });
}

export async function handleFront(request: Request, env: HostEnv, deps: FrontDeps): Promise<Response> {
  const now = (deps.now ?? Date.now)();
  const url = new URL(request.url);
  const label = labelOf(url.hostname, domainOf(env));
  if (!label) return notFound();
  const ring = deps.ring ?? loadKeyring(env);

  if (label === CONTROL_LABEL) {
    if (url.pathname === WELL_KNOWN && request.method === 'GET') return wellKnown(env, ring, now);
    if (url.pathname === '/health' && request.method === 'GET') return json(200, { status: 'ok', version: HOST_VERSION });
    const m = /^\/_filarr\/notify\/([A-Za-z0-9_-]{22})$/.exec(url.pathname);
    if (m && ACCESS_ID_RE.test(m[1]!)) {
      // Le réveil de l'API, ou le premier réveil que l'appli du créateur envoie à la création (CORS du web et du bureau)
      const cors = corsHeaders(request.headers.get('origin'), appOriginOf(env), 'Content-Type, Filarr-Notify');
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
      if (request.method !== 'POST') return json(405, { error: 'Method not allowed', code: 'method_not_allowed' }, { Allow: 'POST', ...cors });
      const res = await deps.box(m[1]!).fetch(forward(request, { [INTERNAL.route]: 'notify', [INTERNAL.access]: m[1]! }));
      return withHeaders(res, cors);
    }
    return notFound();
  }

  const entry = await lookup(deps, label, now);
  if (!entry) return notFound();
  if (entry.erased) {
    if (entry.redirectTo && entry.redirectUntil && Date.parse(entry.redirectUntil) > now) {
      return new Response(null, { status: 308, headers: { Location: `${entry.redirectTo.replace(/\/+$/, '')}${url.pathname}${url.search}`, 'Cache-Control': 'no-store' } });
    }
    return notFound();
  }
  if (url.pathname === WELL_KNOWN && request.method === 'GET') return wellKnown(env, ring, now);
  return deps.box(entry.a).fetch(forward(request, { [INTERNAL.route]: 'box', [INTERNAL.access]: entry.a, [INTERNAL.name]: label }));
}
