/**
 * GARDE DES ESSAIS : aucune connexion ne part vers les serveurs de Filarr (production), par
 * AUCUN chemin. Un oubli de `FILARR_GATE_API_URL` a déjà fait partir un GET non authentifié vers
 * api.filarr.com (le `doctor`, `public/api-limits`) : la seule garde de `fetch` ne voyait ni les
 * sockets (flux `ws`, pilotes PostgreSQL et MySQL, `node:https`), ni les processus enfants (la
 * ligne de commande lancée par les essais), ni `wrangler dev` (workerd fait son propre réseau).
 *
 * Ce fichier (CommonJS, sans dépendance) est chargé :
 *  - dans chaque processus d'essai, par `noProduction.ts` (`setupFiles` de vitest) ;
 *  - dans chaque processus Node ENFANT, par `NODE_OPTIONS=--require <ce fichier>` que la garde
 *    pose sur tout `spawn`, `execFile`, `fork`, `exec` (et leurs variantes synchrones).
 *
 * Ce qu'il refuse :
 *  1. `fetch` vers un hôte interdit ;
 *  2. toute socket TCP ou TLS vers un hôte interdit (`net.Socket.prototype.connect` : `http`,
 *     `https`, `ws`, `pg`, `mysql2` et `fetch` lui-même y passent) ; la résolution DNS d'un hôte
 *     interdit ;
 *  3. un processus enfant lancé avec une adresse de production dans ses arguments ou dans
 *     `FILARR_GATE_API_URL` ; sans `FILARR_GATE_API_URL`, l'enfant reçoit une adresse MORTE de la
 *     boucle locale (rien n'y écoute) au lieu du défaut de production ;
 *  4. `wrangler dev` sans `--var FILARR_GATE_API_URL:<adresse de la boucle locale>` (ou
 *     `FILARR_API_URL:` pour le service hébergé ; workerd échappe aux points 1 et 2), et tout
 *     `wrangler deploy`, `wrangler secret` ou `--remote`.
 *
 * Hôtes interdits : `filarr.com` et ses sous-domaines, plus `garde-production.invalid` (le domaine
 * des essais de la garde elle-même : `.invalid` ne se résout jamais, donc une garde cassée ne fait
 * rien partir vers Filarr pendant qu'on la vérifie).
 */

'use strict';

const net = require('node:net');
const dns = require('node:dns');
const childProcess = require('node:child_process');
const { syncBuiltinESMExports } = require('node:module');

const FORBIDDEN = ['filarr.com', 'garde-production.invalid'];
/** Port 9 (« discard ») de la boucle locale : rien n'y écoute, rien ne quitte la machine. */
const SAFE_API_URL = 'http://127.0.0.1:9';
const SELF = __filename.replace(/\\/g, '/');

function isForbiddenHost(host) {
  const h = String(host == null ? '' : host).trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  return h !== '' && FORBIDDEN.some((d) => h === d || h.endsWith(`.${d}`));
}

function hostOfUrl(raw) {
  try {
    return new URL(String(raw)).hostname;
  } catch {
    return '';
  }
}

function isLoopbackUrl(raw) {
  const h = hostOfUrl(raw).replace(/^\[|\]$/g, '');
  return h === '127.0.0.1' || h === 'localhost' || h === '::1';
}

function refusal(what) {
  const err = new Error(`essai : connexion vers la production refusée (${what})`);
  err.code = 'E_FILARR_PRODUCTION';
  return err;
}

/** Les adresses écrites dans une chaîne (arguments, commande). */
function forbiddenUrlIn(text) {
  for (const m of String(text).matchAll(/(?:https?|wss?):\/\/([^/\s:'"?#]+)/gi)) if (isForbiddenHost(m[1])) return m[0];
  return null;
}

function install() {
  if (globalThis.__filarrNoProduction) return;
  globalThis.__filarrNoProduction = { forbidden: FORBIDDEN.slice(), safeApiUrl: SAFE_API_URL, self: SELF };

  // Le processus lui-même ne part jamais avec une adresse de production
  const env = process.env.FILARR_GATE_API_URL;
  if (env && isForbiddenHost(hostOfUrl(env))) throw refusal(`FILARR_GATE_API_URL=${env}`);
  if (!env) process.env.FILARR_GATE_API_URL = SAFE_API_URL;

  // 1. fetch
  const realFetch = globalThis.fetch;
  if (typeof realFetch === 'function') {
    globalThis.fetch = function guardedFetch(input, init) {
      const raw = typeof input === 'string' || input instanceof URL ? String(input) : input && input.url;
      if (isForbiddenHost(hostOfUrl(raw))) return Promise.reject(refusal(raw));
      return realFetch(input, init);
    };
  }

  // 2. Toute socket TCP ou TLS, et la résolution des noms
  const realConnect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function guardedConnect(...args) {
    let first = args[0];
    // `net.connect` passe des arguments déjà normalisés : [options, rappel]
    if (Array.isArray(first)) first = first[0];
    let host;
    let servername;
    if (first && typeof first === 'object') {
      host = first.host;
      servername = first.servername;
    } else if (typeof first === 'number' || (typeof first === 'string' && /^\d+$/.test(first))) {
      host = typeof args[1] === 'string' ? args[1] : undefined;
    }
    if (isForbiddenHost(host) || isForbiddenHost(servername)) {
      const err = refusal(`socket vers ${host || servername}`);
      process.nextTick(() => this.destroy(err));
      return this;
    }
    return realConnect.apply(this, args);
  };
  const realLookup = dns.lookup;
  dns.lookup = function guardedLookup(hostname, options, callback) {
    if (isForbiddenHost(hostname)) {
      const cb = typeof options === 'function' ? options : callback;
      const err = refusal(`résolution de ${hostname}`);
      if (typeof cb === 'function') process.nextTick(() => cb(err));
      return {};
    }
    return realLookup.apply(this, arguments);
  };
  const realPromiseLookup = dns.promises.lookup;
  dns.promises.lookup = function guardedPromiseLookup(hostname, ...rest) {
    if (isForbiddenHost(hostname)) return Promise.reject(refusal(`résolution de ${hostname}`));
    return realPromiseLookup.call(this, hostname, ...rest);
  };

  // 3, 4. Les processus enfants
  const guardEnv = (given) => {
    const out = { ...(given || process.env) };
    const api = out.FILARR_GATE_API_URL;
    if (api && isForbiddenHost(hostOfUrl(api))) throw refusal(`FILARR_GATE_API_URL=${api} pour un processus enfant`);
    if (!api) out.FILARR_GATE_API_URL = SAFE_API_URL;
    const opts = out.NODE_OPTIONS || '';
    if (!opts.includes(SELF)) out.NODE_OPTIONS = `${opts} --require "${SELF}"`.trim();
    return out;
  };
  const checkCommand = (parts) => {
    const all = parts.map((p) => String(p));
    for (const a of all) {
      const url = forbiddenUrlIn(a);
      if (url) throw refusal(`processus enfant vers ${url}`);
    }
    const joined = all.join(' ');
    if (!/wrangler/i.test(joined)) return;
    const words = joined.split(/\s+/);
    if (words.includes('deploy') || words.includes('publish') || words.includes('secret') || words.includes('--remote')) throw refusal(`wrangler contre Cloudflare : ${joined.slice(0, 120)}`);
    if (words.includes('dev')) {
      // La boîte chez soi lit FILARR_GATE_API_URL ; le service hébergé, FILARR_API_URL
      const v = /\bFILARR_(?:GATE_)?API_URL:(\S+)/.exec(joined);
      if (!v) throw refusal('wrangler dev sans --var FILARR_GATE_API_URL:<adresse de la boucle locale> (workerd échappe à la garde)');
      if (!isLoopbackUrl(v[1])) throw refusal(`wrangler dev vers ${v[1]} (boucle locale seulement)`);
    }
  };
  /** spawn, spawnSync, execFile, execFileSync, fork : (fichier, arguments?, options?, rappel?) */
  const wrapFile = (orig) =>
    function guardedFile(file, ...rest) {
      let i = 0;
      let args = [];
      if (Array.isArray(rest[0])) {
        args = rest[0];
        i = 1;
      } else if (rest[0] === null) i = 1;
      checkCommand([file, ...args]);
      const options = rest[i];
      if (options && typeof options === 'object') rest[i] = { ...options, env: guardEnv(options.env) };
      else rest.splice(i, options === undefined ? 1 : 0, { env: guardEnv(undefined) });
      return orig.call(this, file, ...rest);
    };
  /** exec, execSync : (commande, options?, rappel?) */
  const wrapShell = (orig) =>
    function guardedShell(command, ...rest) {
      checkCommand([command]);
      const options = rest[0];
      if (options && typeof options === 'object') rest[0] = { ...options, env: guardEnv(options.env) };
      else rest.splice(0, options === undefined ? 1 : 0, { env: guardEnv(undefined) });
      return orig.call(this, command, ...rest);
    };
  for (const name of ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'fork']) childProcess[name] = wrapFile(childProcess[name]);
  for (const name of ['exec', 'execSync']) childProcess[name] = wrapShell(childProcess[name]);
  // Les `import { spawn } from 'node:child_process'` des essais voient les fonctions gardées
  syncBuiltinESMExports();
}

install();

module.exports = { isForbiddenHost, forbiddenUrlIn, SAFE_API_URL, SELF };
