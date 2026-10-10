/**
 * Ce que le script `filarr-gate-host` reçoit de Cloudflare (`wrangler.jsonc`) — contrat
 * `gate-heberge-1` § 2.0.2 et § 13. AUCUNE liaison vers une ressource de l'API principale
 * (§ 2.0.4) : ni sa base D1, ni ses compartiments R2, ni son KV, ni ses objets durables, ni une
 * liaison de service. Le service parle à l'API par sa porte publique, signé.
 */

import cliPackage from '../../cli/package.json';

export interface HostEnv {
  /** Une boîte par accès, objets créés en juridiction UE (`GATE_BOX.jurisdiction("eu")`). */
  GATE_BOX: DurableObjectNamespace;
  /** L'annuaire `<hostName>` → accès, et l'annonce de version déjà remise (même juridiction). */
  GATE_DIRECTORY: DurableObjectNamespace;

  // ---- Secrets du seul script (wrangler secret put … --name filarr-gate-host) ----
  /** X25519 : `{"id","privateKey"}` ; `HOST_ENC_<id>` pour les clés suivantes. */
  HOST_ENC?: string;
  /** Ed25519 : `{"id","privateKey"}` ; `HOST_SIG_<id>` pour les clés suivantes. */
  HOST_SIG?: string;
  /** L'adresse de l'API principale (`https://api.filarr.com`). */
  FILARR_API_URL?: string;

  // ---- Variables ----
  /** `gate.filarr.com` : les boîtes répondent sur `<hostName>.<domaine>`, le contrôle sur `ctl.<domaine>`. */
  GATE_HOST_DOMAIN?: string;
  /** L'origine du web de Filarr, admise en CORS sur le canal de gestion (avec `app://`). */
  GATE_APP_ORIGIN?: string;
  /** Posées par la chaîne de mise en service (`deploy-host.yml`), jamais à la main. */
  HOST_CODE_HASH?: string;
  HOST_BUILD_REF?: string;
  HOST_DEPLOYED_AT?: string;
  /** Correctif de sécurité (§ 10.1) : l'identifiant de l'avis, sinon vide. */
  HOST_SECURITY_ADVISORY?: string;
  /** Banc local sous workerd seulement (voir `euNamespace`). */
  GATE_HOST_LOCAL_BENCH?: string;
  [other: string]: unknown;
}

/** La version du code (celle des paquets publiés, embarquée : elle entre dans `codeHash`). */
export const HOST_VERSION: string = (cliPackage as { version: string }).version;

export const CONTROL_LABEL = 'ctl';
export const domainOf = (env: HostEnv): string => (env.GATE_HOST_DOMAIN || 'gate.filarr.com').toLowerCase();
export const appOriginOf = (env: HostEnv): string => env.GATE_APP_ORIGIN || 'https://app.filarr.com';
export const userAgent = `filarr-gate-host/${HOST_VERSION}`;

/** La valeur EXACTE qui, sur le banc local seulement, laisse workerd ouvrir des objets sans juridiction. */
export const LOCAL_BENCH_NO_JURISDICTION = 'workerd-sans-juridiction';

/**
 * L'espace de noms en JURIDICTION UE (§ 7.1, § 10.2) : chaque objet y est créé, stocké et exécuté dans l'UE.
 * workerd (wrangler dev) n'implémente pas les juridictions et lève : le banc local, et lui seul, peut alors s'en
 * passer, s'il le demande EXPLICITEMENT (`GATE_HOST_LOCAL_BENCH`, jamais dans wrangler.jsonc ni dans la chaîne de
 * mise en service : gardes de test). Chez Cloudflare, la juridiction existe : rien ne passe sans elle.
 */
export function euNamespace(ns: DurableObjectNamespace, env: Pick<HostEnv, 'GATE_HOST_LOCAL_BENCH'>): DurableObjectNamespace {
  try {
    return ns.jurisdiction('eu');
  } catch (err) {
    if (env.GATE_HOST_LOCAL_BENCH === LOCAL_BENCH_NO_JURISDICTION && /not implemented in workerd/.test(String((err as Error)?.message ?? err))) return ns;
    throw err;
  }
}

/** Ce qui manque pour servir : l'adresse de l'API (sans elle, rien ne part). */
export function apiUrlOf(env: HostEnv): string | null {
  const u = env.FILARR_API_URL;
  return typeof u === 'string' && /^https?:\/\/[^\s]+$/.test(u) ? u.replace(/\/+$/, '') : null;
}
