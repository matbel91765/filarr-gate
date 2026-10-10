/**
 * Garde des essais : aucune requête ne part vers les serveurs de Filarr (production).
 * Tout essai parle au Filarr en mémoire, ou au worker local du banc.
 */

const realFetch = globalThis.fetch;

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (url.hostname === 'filarr.com' || url.hostname.endsWith('.filarr.com')) {
    throw new Error(`essai : requête vers la production refusée (${url.origin})`);
  }
  return realFetch(input, init);
}) as typeof fetch;
