// LES CLÉS DU SERVICE HÉBERGÉ — contrat gate-heberge-1 § 2.0.5. À LANCER UNE FOIS, par le responsable du compte
// Cloudflare (aujourd'hui Mathis), depuis un poste connecté à ce compte (`npx wrangler login`). Voir docs/RELEASING.md.
//
//   node scripts/host-keys.mjs [--id h1] [--not-before <ISO>] [--not-after <ISO>]          la première paire
//   node scripts/host-keys.mjs --rotate --id h2 --not-before <ISO, ≥ 60 jours plus tard>    la suivante
//
// Ce que fait le script :
//  1. il tire HOST_ENC (X25519 : reçoit les jetons scellés) et HOST_SIG (Ed25519 : signe les requêtes vers l'API,
//     les reçus d'effacement, l'annonce de version), en mémoire ;
//  2. il passe chaque clé PRIVÉE à `wrangler secret put <NOM> --name filarr-gate-host` par l'ENTRÉE STANDARD : jamais
//     sur la ligne de commande, jamais dans un fichier, jamais à l'écran ; noms HOST_ENC et HOST_SIG pour la première
//     paire, HOST_ENC_<id> et HOST_SIG_<id> pour une rotation (le service les lit toutes) ;
//  3. seulement si les deux secrets sont posés, il ajoute l'entrée PUBLIQUE à docs/hosted-keys.json ;
//  4. il n'imprime QUE les clés publiques et l'entrée `{ id, encPublicKey, signPublicKey, notBefore, notAfter }` à
//     embarquer dans les applis (GATE_HOST_KEYS) et à donner à l'API (GATE_HOST_SIGN_KEYS).
//
// Il n'y a AUCUNE copie des clés privées : perdues, elles se remplacent par une rotation (et les boîtes dont le jeton
// est scellé vers l'ancienne clé doivent être confiées de nouveau). Une rotation entre dans une version des applis au
// moins 60 jours avant son `notBefore`.

import { spawn } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const SCRIPT_NAME = 'filarr-gate-host';
export const KEYS_FILE = join(repo, 'docs', 'hosted-keys.json');
const KEY_ID = /^[A-Za-z0-9_-]{1,32}$/;
const DAY = 86_400_000;

const b64urlToStd = (s) => Buffer.from(s, 'base64url').toString('base64');

/** Une paire de clés du service, en mémoire : l'entrée publique et les deux secrets (JSON lu par le service). */
export function generateHostKeys({ id, notBefore, notAfter }) {
  const enc = generateKeyPairSync('x25519');
  const sig = generateKeyPairSync('ed25519');
  const encJwk = enc.privateKey.export({ format: 'jwk' });
  const sigJwk = sig.privateKey.export({ format: 'jwk' });
  const entry = { id, encPublicKey: b64urlToStd(encJwk.x), signPublicKey: b64urlToStd(sigJwk.x), notBefore, notAfter };
  const secrets = {
    enc: JSON.stringify({ id, privateKey: b64urlToStd(encJwk.d) }),
    sig: JSON.stringify({ id, privateKey: b64urlToStd(sigJwk.d) }),
  };
  return { entry, secrets };
}

/** `wrangler secret put <nom> --name filarr-gate-host`, la valeur par l'entrée standard (jamais en argument). */
export function wranglerSecretPut(name, value, { config } = {}) {
  const wrangler = join(repo, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
  const args = [wrangler, 'secret', 'put', name, '--name', SCRIPT_NAME, ...(config ? ['--config', config] : [])];
  return new Promise((resolvePut, reject) => {
    const child = spawn(process.execPath, args, { cwd: repo, stdio: ['pipe', 'inherit', 'inherit'] });
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolvePut() : reject(new Error(`wrangler secret put ${name} : code ${code}`))));
    child.stdin.end(value);
  });
}

function parseArgs(argv) {
  const arg = (name) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  return { id: arg('id'), notBefore: arg('not-before'), notAfter: arg('not-after'), rotate: argv.includes('--rotate'), config: arg('config'), keys: arg('keys') };
}

/**
 * @param {string[]} argv
 * @param {{ putSecret?: (name: string, value: string) => Promise<void>, log?: (line: string) => void, keysFile?: string, now?: number }} io
 */
export async function main(argv, io = {}) {
  const opts = parseArgs(argv);
  const log = io.log ?? ((line) => console.log(line));
  const keysFile = opts.keys ? resolve(opts.keys) : (io.keysFile ?? KEYS_FILE);
  const now = io.now ?? Date.now();
  const list = JSON.parse(readFileSync(keysFile, 'utf8'));
  if (!Array.isArray(list)) throw new Error(`${keysFile} : une liste JSON est attendue`);
  if (!opts.rotate && list.length > 0) throw new Error('la liste a déjà une clé : pour la suivante, --rotate --id <id> --not-before <date ≥ 60 jours plus tard>');
  if (opts.rotate && list.length === 0) throw new Error('aucune clé encore : lancer sans --rotate pour la première');
  const id = opts.id ?? (opts.rotate ? `h${list.length + 1}` : 'h1');
  if (!KEY_ID.test(id)) throw new Error(`identifiant « ${id} » : 1 à 32 caractères [A-Za-z0-9_-]`);
  if (list.some((k) => k.id === id)) throw new Error(`la clé « ${id} » existe déjà dans ${keysFile}`);
  const notBefore = new Date(opts.notBefore ? Date.parse(opts.notBefore) : Math.floor(now / 1000) * 1000);
  const notAfter = new Date(opts.notAfter ? Date.parse(opts.notAfter) : notBefore.getTime() + 2 * 365 * DAY);
  if (!Number.isFinite(notBefore.getTime()) || !Number.isFinite(notAfter.getTime()) || notAfter <= notBefore) throw new Error('dates invalides : --not-before < --not-after, au format ISO');
  if (opts.rotate && notBefore.getTime() - now < 60 * DAY) throw new Error('rotation : --not-before doit être au moins 60 jours plus tard (le temps qu’une version des applis l’embarque)');

  const { entry, secrets } = generateHostKeys({ id, notBefore: notBefore.toISOString(), notAfter: notAfter.toISOString() });
  const names = opts.rotate ? { enc: `HOST_ENC_${id}`, sig: `HOST_SIG_${id}` } : { enc: 'HOST_ENC', sig: 'HOST_SIG' };
  const put = io.putSecret ?? ((name, value) => wranglerSecretPut(name, value, { config: opts.config }));
  log(`Clés du service ${SCRIPT_NAME}, « ${id} » : les clés privées partent vers Cloudflare par l'entrée standard de wrangler.`);
  await put(names.enc, secrets.enc);
  await put(names.sig, secrets.sig);
  // Les secrets sont posés : seule la partie publique est gardée
  list.push(entry);
  writeFileSync(keysFile, `${JSON.stringify(list, null, 2)}\n`);
  log('');
  log(`Secrets posés : ${names.enc}, ${names.sig} (script ${SCRIPT_NAME}).`);
  log(`Entrée ajoutée à ${keysFile} :`);
  log(JSON.stringify(entry, null, 2));
  log('');
  log('À embarquer dans les applis (GATE_HOST_KEYS) et à donner à l’API (variable GATE_HOST_SIGN_KEYS, la liste entière) :');
  log(JSON.stringify(list));
  return { entry, names };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(`host-keys : ${err.message}`);
    process.exit(1);
  });
}
