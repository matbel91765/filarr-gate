/**
 * L'ANNUAIRE DES BOÎTES — un seul objet durable (`GATE_DIRECTORY`, nom fixe, juridiction UE).
 *
 * L'adresse `<hostName>.gate.filarr.com` est donnée aux logiciels ; l'objet d'une boîte est nommé
 * par son `accessId` (c'est lui que portent les réveils et les routes signées de l'API). L'annuaire
 * fait le lien, et rien de plus :
 *   h:<hostName>  { a: accessId, erased?: true, redirectTo?, redirectUntil? }
 *   announced     l'identifiant de la dernière annonce de version remise à l'API
 *
 * Une entrée n'est écrite que par l'objet d'une boîte, après avoir lu son `hostName` dans la
 * réponse SIGNÉE de l'API (`GET /api-access/hosted/:id/token`) ET vérifié le réveil qui l'a
 * appelé (HMAC sous `A_notify`, tiré du jeton qu'il vient d'ouvrir). Aucun contenu ici : un nom
 * d'hôte (public : il est donné aux logiciels), un identifiant d'accès, une redirection.
 *
 * Après l'effacement d'une boîte, son entrée reste en pierre tombale : l'adresse répond `404`, ou
 * `308` vers la nouvelle adresse pendant les 30 jours d'une migration (§ 8.4), sans lire ni garder
 * la requête.
 */

import { euNamespace, type HostEnv } from './env';
import { json } from './http';
import { opsError } from './ops';
import { announcementId } from './version';
import type { VersionAnnouncement } from './wire';
import type { DoStorage } from '../../cloudflare/src/storage';

export interface DirectoryEntry {
  a: string;
  erased?: true;
  redirectTo?: string;
  redirectUntil?: string;
}

const HOST_NAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,29})-[a-z0-9]{4}$/;
const ACCESS_ID_RE = /^[A-Za-z0-9_-]{22}$/;

/** La logique de l'annuaire, sur un stockage clé-valeur (essayée sans moteur Workers). */
export class Directory {
  constructor(
    private readonly storage: DoStorage,
    private readonly announce: ((a: VersionAnnouncement & { sig: string }) => Promise<void>) | null = null
  ) {}

  async lookup(hostName: string): Promise<DirectoryEntry | null> {
    if (!HOST_NAME_RE.test(hostName)) return null;
    return (await this.storage.get<DirectoryEntry>(`h:${hostName}`)) ?? null;
  }

  /** Une boîte vivante : refusé si le nom est tenu par un AUTRE accès encore en service. */
  async register(hostName: string, accessId: string): Promise<boolean> {
    if (!HOST_NAME_RE.test(hostName) || !ACCESS_ID_RE.test(accessId)) return false;
    const current = await this.lookup(hostName);
    if (current && current.a !== accessId && !current.erased) return false;
    if (current && current.a === accessId && !current.erased) return true;
    await this.storage.put(`h:${hostName}`, { a: accessId } satisfies DirectoryEntry);
    return true;
  }

  /** La boîte est effacée : pierre tombale, avec la redirection d'une migration s'il y en a une. */
  async tombstone(hostName: string, accessId: string, redirect: { to: string; until: string } | null): Promise<boolean> {
    if (!HOST_NAME_RE.test(hostName) || !ACCESS_ID_RE.test(accessId)) return false;
    const current = await this.lookup(hostName);
    if (current && current.a !== accessId) return false;
    const entry: DirectoryEntry = { a: accessId, erased: true };
    if (redirect && /^https:\/\/[^\s]+$/.test(redirect.to) && Number.isFinite(Date.parse(redirect.until))) {
      entry.redirectTo = redirect.to;
      entry.redirectUntil = redirect.until;
    }
    await this.storage.put(`h:${hostName}`, entry);
    return true;
  }

  /** Remet l'annonce de version à l'API, une fois par mise en service. */
  async announceOnce(a: VersionAnnouncement & { sig: string }): Promise<'sent' | 'already' | 'failed'> {
    const id = announcementId(a);
    if ((await this.storage.get<string>('announced')) === id) return 'already';
    if (!this.announce) return 'failed';
    try {
      await this.announce(a);
    } catch {
      opsError('announce_failed');
      return 'failed';
    }
    await this.storage.put('announced', id);
    return 'sent';
  }
}

/** Les requêtes internes de l'objet durable (aucune route publique n'y mène). */
export async function handleDirectoryRequest(directory: Directory, request: Request): Promise<Response> {
  const url = new URL(request.url);
  try {
    if (url.pathname === '/lookup' && request.method === 'GET') return json(200, { entry: await directory.lookup(url.searchParams.get('h') ?? '') });
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) return json(400, { code: 'bad_request' });
    if (url.pathname === '/register' && request.method === 'PUT') {
      return json(200, { ok: await directory.register(String(body.hostName ?? ''), String(body.accessId ?? '')) });
    }
    if (url.pathname === '/tombstone' && request.method === 'PUT') {
      const redirect = typeof body.redirectTo === 'string' && typeof body.redirectUntil === 'string' ? { to: body.redirectTo, until: body.redirectUntil } : null;
      return json(200, { ok: await directory.tombstone(String(body.hostName ?? ''), String(body.accessId ?? ''), redirect) });
    }
    if (url.pathname === '/announce' && request.method === 'POST') {
      return json(200, { result: await directory.announceOnce(body as unknown as VersionAnnouncement & { sig: string }) });
    }
    return json(404, { code: 'not_found' });
  } catch {
    opsError('directory_failed');
    return json(500, { code: 'directory_failed' });
  }
}

/** Le talon de l'annuaire (un seul objet, en juridiction UE). */
export function directoryStub(env: Pick<HostEnv, 'GATE_DIRECTORY' | 'GATE_HOST_LOCAL_BENCH'>): DurableObjectStub {
  const ns = euNamespace(env.GATE_DIRECTORY, env);
  return ns.get(ns.idFromName('directory'));
}

/** Les appels à l'annuaire depuis le Worker ou une boîte. */
export class DirectoryClient {
  constructor(private readonly stub: () => DurableObjectStub) {}

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.stub().fetch(
      new Request(`https://directory${path}`, { method, ...(body !== undefined ? { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } } : {}) })
    );
    if (!res.ok) throw new Error(`annuaire : ${res.status}`);
    return (await res.json()) as T;
  }

  async lookup(hostName: string): Promise<DirectoryEntry | null> {
    return (await this.call<{ entry: DirectoryEntry | null }>('GET', `/lookup?h=${encodeURIComponent(hostName)}`)).entry;
  }

  async register(hostName: string, accessId: string): Promise<boolean> {
    return (await this.call<{ ok: boolean }>('PUT', '/register', { hostName, accessId })).ok;
  }

  async tombstone(hostName: string, accessId: string, redirect: { to: string; until: string } | null): Promise<boolean> {
    return (await this.call<{ ok: boolean }>('PUT', '/tombstone', { hostName, accessId, ...(redirect ? { redirectTo: redirect.to, redirectUntil: redirect.until } : {}) })).ok;
  }

  async announce(a: VersionAnnouncement & { sig: string }): Promise<string> {
    return (await this.call<{ result: string }>('POST', '/announce', a)).result;
  }
}
