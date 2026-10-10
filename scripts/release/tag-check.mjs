// L'étiquette d'une publication est-elle signée par une clé déclarée, et est-ce un correctif de sécurité ?
// Contrat gate-heberge-1 § 10.1 ; vecteurs : test/vectors/gate-heberge-1-gate.vectors.json (famille 9).
//
// Node seul (node:crypto), aucune dépendance : la chaîne de publication le lance AVANT `npm ci`.
//
//   node scripts/release/tag-check.mjs --tag v0.2.0 --raw <objet d'étiquette> --signers <fichier>
//        [--github-output <fichier>]
//
// - L'objet d'étiquette est celui de `git cat-file tag <étiquette>` : en-têtes, message, puis la signature SSH
//   de git (`gpg.format ssh`) collée à la fin (« -----BEGIN SSH SIGNATURE----- »).
// - Les signataires sont au format `allowed_signers` d'OpenSSH (celui de `gpg.ssh.allowedSignersFile`), un
//   principal par ligne, de la forme `release:<nom>` (publications ordinaires) ou `security:<nom>` (correctifs
//   de sécurité) ; seule l'option `namespaces="git"` est admise ; clés Ed25519 seulement ; une même clé ne peut
//   pas tenir les deux rôles.
// - Correctif de sécurité : étiquette `vX.Y.Z-security`, signée par une clé de rôle `security`, dont le
//   dernier paragraphe du message porte `Filarr-Release-Kind: security` et `Filarr-Advisory: GHSA-…`, avis
//   existant dans le dépôt. Une seule condition manque : publication ordinaire (`security.refused` dit laquelle).
// - Code de sortie 1 si l'étiquette est refusée (non signée, signature fausse, clé inconnue, nom invalide…).

import { createHash, createPublicKey, verify } from 'node:crypto';
import { appendFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const ROLES = ['release', 'security'];
export const NAMESPACE = 'git';
export const KIND_TRAILER = 'Filarr-Release-Kind';
export const ADVISORY_TRAILER = 'Filarr-Advisory';
export const TAG_NAME = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-security)?$/;
export const ADVISORY_ID = /^GHSA(-[23456789cfghjmpqrvwx]{4}){3}$/;
const BEGIN = '-----BEGIN SSH SIGNATURE-----';
const END = '-----END SSH SIGNATURE-----';
const SPKI_ED25519 = Buffer.from('302a300506032b6570032100', 'hex');

// ── Lecture des octets SSH (RFC 4251 : uint32 longueur ‖ octets) ─────────────

function reader(buf) {
  let at = 0;
  const take = (n) => {
    if (at + n > buf.length) throw new Error('signature SSH tronquée');
    const out = buf.subarray(at, at + n);
    at += n;
    return out;
  };
  return {
    raw: take,
    u32: () => take(4).readUInt32BE(0),
    string: () => take(take(4).readUInt32BE(0)),
    done: () => at === buf.length,
  };
}

const sshString = (data) => {
  const b = Buffer.from(data);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(b.length, 0);
  return Buffer.concat([len, b]);
};

/** Clé publique Ed25519 brute (32 o) d'un blob `ssh-ed25519`. */
export function ed25519FromBlob(blob) {
  const r = reader(blob);
  const type = r.string().toString('latin1');
  if (type !== 'ssh-ed25519') throw new Error(`clé ${type} : seules les clés Ed25519 sont admises`);
  const key = r.string();
  if (key.length !== 32 || !r.done()) throw new Error('clé Ed25519 mal formée');
  return Buffer.from(key);
}

// ── Les signataires (`allowed_signers`) ──────────────────────────────────────

function tokens(line) {
  const out = [];
  let cur = '';
  let quoted = false;
  for (const ch of line) {
    if (ch === '"') quoted = !quoted;
    if (!quoted && /\s/.test(ch)) {
      if (cur) out.push(cur);
      cur = '';
    } else cur += ch;
  }
  if (quoted) throw new Error('guillemet non fermé');
  if (cur) out.push(cur);
  return out;
}

/** Lit `.github/release-signers`. Lève sur toute ligne qu'elle ne sait pas lire : mieux vaut refuser que deviner. */
export function parseSigners(text) {
  const signers = [];
  text.split(/\r?\n/).forEach((rawLine, i) => {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) return;
    const where = `release-signers, ligne ${i + 1}`;
    const t = tokens(line);
    if (t.length < 3) throw new Error(`${where} : « principal [options] type clé » attendu`);
    const [principal] = t;
    let k = 1;
    let namespaces = null;
    if (!t[1].startsWith('ssh-') && !t[1].startsWith('sk-') && !t[1].startsWith('ecdsa-')) {
      for (const opt of t[1].split(',')) {
        const m = /^namespaces="([^"]*)"$/.exec(opt);
        if (!m) throw new Error(`${where} : option non admise (${opt}) ; seule namespaces="git" l'est`);
        namespaces = m[1].split(',');
      }
      k = 2;
    }
    const [keyType, keyB64] = [t[k], t[k + 1]];
    if (keyType !== 'ssh-ed25519' || !keyB64) throw new Error(`${where} : clé ssh-ed25519 attendue`);
    if (namespaces && !namespaces.includes(NAMESPACE)) throw new Error(`${where} : l'espace « git » n'est pas permis`);
    const m = /^([a-z]+):([A-Za-z0-9._@-]+)$/.exec(principal);
    if (!m || !ROLES.includes(m[1])) throw new Error(`${where} : principal « release:<nom> » ou « security:<nom> » attendu`);
    const blob = Buffer.from(keyB64, 'base64');
    if (blob.toString('base64') !== keyB64) throw new Error(`${where} : clé en base64 invalide`);
    signers.push({ principal, role: m[1], name: m[2], keyB64, publicKey: ed25519FromBlob(blob) });
  });
  const byKey = new Map();
  for (const s of signers) {
    const role = byKey.get(s.keyB64);
    if (role && role !== s.role) throw new Error(`la clé de ${s.principal} tient les deux rôles : elles doivent être distinctes`);
    byKey.set(s.keyB64, s.role);
  }
  return signers;
}

// ── La signature SSH de git (PROTOCOL.sshsig d'OpenSSH) ──────────────────────

/** Sépare l'objet d'étiquette en charge signée et signature armurée (null si l'étiquette n'est pas signée en SSH). */
export function splitSignedTag(raw) {
  const text = raw.replace(/\r\n/g, '\n');
  const at = text.lastIndexOf(`\n${BEGIN}\n`);
  if (at < 0) return null;
  const armored = text.slice(at + 1);
  if (!armored.trimEnd().endsWith(END)) return null;
  return { payload: text.slice(0, at + 1), armored };
}

/** Lit l'objet d'étiquette : en-têtes (object, type, tag, tagger) et message. */
export function parseTagObject(payload) {
  const cut = payload.indexOf('\n\n');
  const head = cut < 0 ? payload : payload.slice(0, cut);
  const headers = {};
  for (const line of head.split('\n')) {
    const sp = line.indexOf(' ');
    if (sp > 0 && !(line.slice(0, sp) in headers)) headers[line.slice(0, sp)] = line.slice(sp + 1);
  }
  return { ...headers, message: cut < 0 ? '' : payload.slice(cut + 2) };
}

/** Vérifie une signature SSHSIG Ed25519 sur `message` ; rend la clé publique signataire, ou lève. */
export function verifySshSignature(armored, message, namespace = NAMESPACE) {
  const body = armored.replace(/\r\n/g, '\n').trim();
  if (!body.startsWith(BEGIN) || !body.endsWith(END)) throw new Error('signature SSH mal armurée');
  const blob = Buffer.from(body.slice(BEGIN.length, -END.length).replace(/\s+/g, ''), 'base64');
  const r = reader(blob);
  if (r.raw(6).toString('latin1') !== 'SSHSIG') throw new Error('ce n’est pas une signature SSHSIG');
  if (r.u32() !== 1) throw new Error('version de SSHSIG inconnue');
  const keyBlob = r.string();
  const ns = r.string().toString('utf8');
  const reserved = r.string();
  const hashAlg = r.string().toString('latin1');
  const sigBlob = r.string();
  if (!r.done()) throw new Error('signature SSH : octets en trop');
  if (ns !== namespace) throw new Error(`signature de l'espace « ${ns} », « ${namespace} » attendu`);
  if (hashAlg !== 'sha512' && hashAlg !== 'sha256') throw new Error(`hachage ${hashAlg} non admis`);
  const publicKey = ed25519FromBlob(keyBlob);
  const s = reader(sigBlob);
  if (s.string().toString('latin1') !== 'ssh-ed25519') throw new Error('signature non Ed25519');
  const sig = s.string();
  if (sig.length !== 64 || !s.done()) throw new Error('signature Ed25519 mal formée');
  const digest = createHash(hashAlg).update(Buffer.from(message, 'utf8')).digest();
  const signed = Buffer.concat([Buffer.from('SSHSIG', 'latin1'), sshString(ns), sshString(reserved), sshString(hashAlg), sshString(digest)]);
  const key = createPublicKey({ key: Buffer.concat([SPKI_ED25519, publicKey]), format: 'der', type: 'spki' });
  if (!verify(null, signed, key, sig)) throw new Error('signature fausse');
  return { publicKey, keyB64: keyBlob.toString('base64'), hashAlg };
}

// ── Les lignes de pied du message ───────────────────────────────────────────

/** Les lignes `Clé: valeur` du DERNIER paragraphe du message (les « trailers » de git), en liste. */
export function trailers(message) {
  const paragraphs = message.replace(/\r\n/g, '\n').trimEnd().split(/\n\s*\n/);
  const last = paragraphs[paragraphs.length - 1] ?? '';
  const out = [];
  for (const line of last.split('\n')) {
    const m = /^([A-Za-z0-9][A-Za-z0-9-]*): ?(.*)$/.exec(line.trimEnd());
    if (m) out.push([m[1], m[2].trim()]);
  }
  return out;
}

// ── La décision ─────────────────────────────────────────────────────────────

/**
 * @param {{ tag: string, raw: string, signers: string, advisoryExists: (id: string) => Promise<boolean> | boolean }} input
 */
export async function checkTag({ tag, raw, signers, advisoryExists }) {
  const refuse = (refused, detail) => ({ ok: false, tag, refused, detail });
  const name = TAG_NAME.exec(tag);
  if (!name) return refuse('tag-name', 'étiquette vX.Y.Z ou vX.Y.Z-security attendue');
  let list;
  try {
    list = parseSigners(signers);
  } catch (e) {
    return refuse('signers', e.message);
  }
  const split = splitSignedTag(raw);
  if (!split) return refuse('unsigned', 'étiquette sans signature SSH (git tag -s, gpg.format ssh)');
  let sig;
  try {
    sig = verifySshSignature(split.armored, split.payload);
  } catch (e) {
    return refuse('signature-invalid', e.message);
  }
  const signer = list.find((s) => s.keyB64 === sig.keyB64);
  if (!signer) return refuse('signer-unknown', 'clé absente de .github/release-signers');
  const obj = parseTagObject(split.payload);
  if (obj.tag !== tag) return refuse('tag-mismatch', `l'objet signé nomme « ${obj.tag} »`);
  if (obj.type !== 'commit' || !/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(obj.object ?? '')) return refuse('not-commit', 'l’étiquette doit viser un commit');
  const result = {
    ok: true,
    tag,
    version: `${name[1]}.${name[2]}.${name[3]}`,
    commit: obj.object,
    principal: signer.principal,
    role: signer.role,
    kind: 'release',
  };
  if (!name[4]) return result;
  const pied = trailers(obj.message);
  const values = (key) => pied.filter(([k]) => k === key).map(([, v]) => v);
  const kind = values(KIND_TRAILER);
  const advisory = values(ADVISORY_TRAILER);
  const fallback = (refused) => ({ ...result, security: { refused } });
  if (signer.role !== 'security') return fallback('role');
  if (kind.length !== 1 || kind[0] !== 'security') return fallback('kind-line-missing');
  if (advisory.length !== 1 || !advisory[0]) return fallback('advisory-line-missing');
  if (!ADVISORY_ID.test(advisory[0])) return fallback('advisory-format');
  if (!(await advisoryExists(advisory[0]))) return fallback('advisory-unknown');
  return { ...result, kind: 'security', security: { advisory: advisory[0] } };
}

/** L'avis existe-t-il dans le dépôt ? (API de GitHub ; un avis encore privé demande un jeton qui le lit.) */
export async function githubAdvisoryExists(id, { repository = process.env.GITHUB_REPOSITORY, token = process.env.GH_TOKEN } = {}) {
  if (!repository) return false;
  const res = await fetch(`https://api.github.com/repos/${repository}/security-advisories/${id}`, {
    headers: { accept: 'application/vnd.github+json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
  });
  return res.status === 200;
}

// ── Ligne de commande ───────────────────────────────────────────────────────

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const arg = (name) => {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 ? process.argv[i + 1] : undefined;
  };
  const tag = arg('tag');
  const rawFile = arg('raw');
  const signersFile = arg('signers');
  if (!tag || !rawFile || !signersFile) {
    console.error('usage : node scripts/release/tag-check.mjs --tag <vX.Y.Z> --raw <objet> --signers <fichier> [--github-output <fichier>]');
    process.exit(2);
  }
  const result = await checkTag({
    tag,
    raw: readFileSync(rawFile, 'utf8'),
    signers: readFileSync(signersFile, 'utf8'),
    advisoryExists: (id) => githubAdvisoryExists(id),
  });
  console.log(JSON.stringify(result, null, 2));
  const out = arg('github-output');
  if (out && result.ok) {
    const lines = [`version=${result.version}`, `kind=${result.kind}`, `commit=${result.commit}`, `principal=${result.principal}`];
    if (result.security?.advisory) lines.push(`advisory=${result.security.advisory}`);
    if (result.security?.refused) lines.push(`security_refused=${result.security.refused}`);
    appendFileSync(out, lines.join('\n') + '\n');
  }
  process.exit(result.ok ? 0 : 1);
}
