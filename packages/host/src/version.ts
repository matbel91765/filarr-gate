/**
 * L'ANNONCE DE VERSION — contrat `gate-heberge-1` § 7.4 et § 10.1 (point 5).
 *
 * `GET https://<hôte>/.well-known/filarr-gate-host.json` →
 * `{ version, codeHash, buildRef, deployedAt, keyId, sig }` (plus `security: true, advisory` pour un
 * correctif de sécurité), `sig` = Ed25519 `HOST_SIG` sur `"filarr/gate-host/v1|version|" + JSON
 * canonique sans sig`. La même annonce est remise à l'API principale à chaque mise en service
 * (`POST /api-access/hosted/version`), qui l'écrit au journal de chaque accès hébergé.
 *
 * `version` vient du code (la version des paquets publiés). `codeHash` (`sha256:` + SHA-256 du
 * fichier `SHA256SUMS` de la publication, PH7), `buildRef` (l'étiquette) et `deployedAt` sont posés
 * par la chaîne de mise en service : ils ne peuvent pas être dans le code, que `codeHash` couvre.
 * On vérifie la CONCORDANCE de ce que le service annonce ; aucune attestation à distance n'existe
 * sur Workers (§ 1.2).
 */

import { HOST_VERSION, type HostEnv } from './env';
import { signingKey, type HostKeyring } from './keys';
import { signVersion, type VersionAnnouncement } from './wire';

const CODE_HASH = /^sha256:[0-9a-f]{64}$/;
const ADVISORY = /^GHSA(-[23456789cfghjmpqrvwx]{4}){3}$/;

/** L'annonce signée, ou `null` si le service n'a pas été mis en service par la chaîne (variables absentes) ou n'a pas de clé. */
export function announcement(env: HostEnv, ring: HostKeyring, now: number): (VersionAnnouncement & { sig: string }) | null {
  const codeHash = env.HOST_CODE_HASH;
  const buildRef = env.HOST_BUILD_REF;
  const deployedAt = env.HOST_DEPLOYED_AT;
  if (typeof codeHash !== 'string' || !CODE_HASH.test(codeHash)) return null;
  if (typeof buildRef !== 'string' || buildRef.length === 0 || buildRef.length > 80) return null;
  if (typeof deployedAt !== 'string' || !Number.isFinite(Date.parse(deployedAt))) return null;
  const key = signingKey(ring, now);
  if (!key) return null;
  const advisory = typeof env.HOST_SECURITY_ADVISORY === 'string' && ADVISORY.test(env.HOST_SECURITY_ADVISORY) ? env.HOST_SECURITY_ADVISORY : null;
  const base: VersionAnnouncement = {
    version: HOST_VERSION,
    codeHash,
    buildRef,
    deployedAt,
    keyId: key.id,
    ...(advisory ? { security: true as const, advisory } : {}),
  };
  return signVersion(key, base);
}

/** Ce qui identifie une mise en service : on ne la remet qu'une fois à l'API. */
export const announcementId = (a: VersionAnnouncement): string => `${a.version}|${a.codeHash}|${a.buildRef}|${a.deployedAt}|${a.keyId}`;
