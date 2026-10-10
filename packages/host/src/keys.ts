/**
 * Les clés du service hébergé — contrat `gate-heberge-1` § 2.0.5.
 *
 *  - La liste PUBLIQUE (`docs/hosted-keys.json`, la même que `GATE_HOST_KEYS` des applis et que
 *    `GATE_HOST_SIGN_KEYS` de l'API) est EMBARQUÉE dans le code du service : son empreinte entre
 *    dans `codeHash`. Elle dit quelle clé signe à quel moment (`notBefore`, `notAfter`).
 *  - Les clés PRIVÉES sont des secrets du seul script `filarr-gate-host` :
 *      `HOST_ENC`, `HOST_SIG`              la première paire (`scripts/host-keys.mjs`) ;
 *      `HOST_ENC_<id>`, `HOST_SIG_<id>`    les suivantes (rotation, `--rotate`).
 *    Valeur : `{"id":"<id>","privateKey":"<base64 standard, 32 octets>"}`. Une clé privée dont la clé
 *    publique ne correspond pas à l'entrée épinglée de même `id` est IGNORÉE (jamais devinée).
 */

import pinnedFile from '../../../docs/hosted-keys.json';
import { fromBase64Std, toBase64Std } from '../../core/src/engine/store/apiAccess';
import { curves } from '../../gate/src/crypto/providers';

export interface PinnedHostKey {
  id: string;
  encPublicKey: string;
  signPublicKey: string;
  notBefore: string;
  notAfter: string;
}

export interface HostPrivateKey {
  id: string;
  privateKey: Uint8Array;
}

export interface HostKeyring {
  pinned: PinnedHostKey[];
  /** X25519, par identifiant : ouvre les jetons scellés. */
  enc: Map<string, HostPrivateKey>;
  /** Ed25519, par identifiant : signe requêtes, reçus et annonces. */
  sig: Map<string, HostPrivateKey>;
}

const KEY_ID_RE = /^[A-Za-z0-9_-]{1,32}$/;

/** La liste épinglée, filtrée (une entrée malformée est ignorée). */
export function readPinned(raw: unknown): PinnedHostKey[] {
  if (!Array.isArray(raw)) return [];
  const out: PinnedHostKey[] = [];
  for (const k of raw as Array<Record<string, unknown>>) {
    if (!k || typeof k.id !== 'string' || !KEY_ID_RE.test(k.id)) continue;
    if (typeof k.encPublicKey !== 'string' || typeof k.signPublicKey !== 'string') continue;
    if (typeof k.notBefore !== 'string' || typeof k.notAfter !== 'string') continue;
    if (!Number.isFinite(Date.parse(k.notBefore)) || !Number.isFinite(Date.parse(k.notAfter))) continue;
    try {
      if (fromBase64Std(k.encPublicKey).length !== 32 || fromBase64Std(k.signPublicKey).length !== 32) continue;
    } catch {
      continue;
    }
    out.push({ id: k.id, encPublicKey: k.encPublicKey, signPublicKey: k.signPublicKey, notBefore: k.notBefore, notAfter: k.notAfter });
  }
  return out;
}

export const EMBEDDED_KEYS: PinnedHostKey[] = readPinned(pinnedFile);

function parseSecret(raw: unknown): HostPrivateKey | null {
  if (typeof raw !== 'string' || raw.length > 512) return null;
  try {
    const o = JSON.parse(raw) as { id?: unknown; privateKey?: unknown };
    if (typeof o.id !== 'string' || !KEY_ID_RE.test(o.id) || typeof o.privateKey !== 'string') return null;
    const privateKey = fromBase64Std(o.privateKey);
    return privateKey.length === 32 ? { id: o.id, privateKey } : null;
  } catch {
    return null;
  }
}

/** Les secrets `HOST_ENC*` et `HOST_SIG*` de l'environnement, vérifiés contre la liste épinglée. */
export function loadKeyring(env: Record<string, unknown>, pinned: PinnedHostKey[] = EMBEDDED_KEYS): HostKeyring {
  const ring: HostKeyring = { pinned, enc: new Map(), sig: new Map() };
  for (const [name, value] of Object.entries(env)) {
    const kind = /^HOST_(ENC|SIG)(?:_[A-Za-z0-9_-]{1,32})?$/.exec(name)?.[1];
    if (!kind) continue;
    const key = parseSecret(value);
    if (!key) continue;
    const pin = pinned.find((p) => p.id === key.id);
    if (!pin) continue;
    if (kind === 'ENC' && toBase64Std(curves.x25519PublicKey(key.privateKey)) === pin.encPublicKey) ring.enc.set(key.id, key);
    if (kind === 'SIG' && toBase64Std(curves.ed25519PublicKey(key.privateKey)) === pin.signPublicKey) ring.sig.set(key.id, key);
  }
  return ring;
}

export const keyValidAt = (k: PinnedHostKey, now: number): boolean => Date.parse(k.notBefore) <= now && now < Date.parse(k.notAfter);

/** La clé qui signe maintenant : la plus récente (`notBefore`) des clés valides dont le service tient la privée. */
export function signingKey(ring: HostKeyring, now: number): HostPrivateKey | null {
  let best: PinnedHostKey | null = null;
  for (const k of ring.pinned) {
    if (!keyValidAt(k, now) || !ring.sig.has(k.id)) continue;
    if (!best || Date.parse(best.notBefore) < Date.parse(k.notBefore)) best = k;
  }
  return best ? ring.sig.get(best.id)! : null;
}
