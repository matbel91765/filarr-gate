/** Réponses du service : enveloppe d'erreur de Filarr Gate, sommeil, CORS du canal de gestion. */

const SECURITY = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
};

export function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...SECURITY, ...headers } });
}

export const notFound = (headers: Record<string, string> = {}): Response => json(404, { error: 'Not found', code: 'not_found' }, headers);

/** Ce que dit `remedy` d'un sommeil (gate-heberge-1 § 14, `hosting_asleep` et `gate_asleep`). */
export function sleepRemedy(reason: string | null): string[] | undefined {
  if (reason === 'billing') return ['updatePayment'];
  if (reason === 'tier') return ['upgrade'];
  return undefined;
}

/** `503 gate_asleep` : la boîte dort (impayé, palier, politique, arrêt d'urgence) ; rien n'est servi. */
export function gateAsleep(reason: string | null, sleepUntil: string | null, headers: Record<string, string> = {}): Response {
  const remedy = sleepRemedy(reason);
  return json(
    503,
    { error: 'This hosted box is asleep', code: 'gate_asleep', reason, sleepUntil, ...(remedy ? { remedy } : {}) },
    { 'Retry-After': '3600', ...headers }
  );
}

/** Les origines admises sur le canal de gestion et sur le réveil de l'appli (§ 7.2) : le web et le bureau. */
export function allowedAppOrigin(origin: string | null, appOrigin: string): string | null {
  if (!origin) return null;
  if (origin === appOrigin) return origin;
  if (/^app:\/\/[A-Za-z0-9.-]*$/.test(origin)) return origin;
  return null;
}

export function corsHeaders(origin: string | null, appOrigin: string, allowHeaders: string): Record<string, string> {
  const allowed = allowedAppOrigin(origin, appOrigin);
  if (!allowed) return {};
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': allowHeaders,
    'Access-Control-Max-Age': '600',
    Vary: 'Origin',
  };
}

export function withHeaders(res: Response, extra: Record<string, string>): Response {
  if (Object.keys(extra).length === 0) return res;
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(extra)) headers.set(k, v);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

/** Le 1er du mois suivant, minuit UTC (le compteur d'appels repart, § 7.3). */
export function nextMonthUtc(now: number): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
}

export const periodOf = (now: number): string => new Date(now).toISOString().slice(0, 7);
