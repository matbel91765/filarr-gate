/**
 * LE SERVICE HÉBERGÉ DE FILARR GATE — script `filarr-gate-host` (contrat `gate-heberge-1`).
 *
 * Un Worker du compte Cloudflare de l'API, isolé par script (« montage A », § 2.0) : ses objets
 * durables, ses secrets, AUCUNE liaison avec le script de l'API. Monté par la route
 * `*.gate.filarr.com/*` (certificat avancé de la zone `filarr.com`).
 *
 *  - `fetch` : le Worker devant les boîtes (`front.ts`) ;
 *  - `scheduled` : remet l'annonce de version à l'API, une fois par mise en service (§ 7.4) ;
 *  - `GateBox` : une boîte par accès (`box.ts`), objet créé en juridiction UE ;
 *  - `GateDirectory` : l'annuaire `<hostName>` → accès (`directory.ts`), même juridiction.
 *
 * Mis en service UNIQUEMENT par la chaîne d'intégration (`.github/workflows/deploy-host.yml`), depuis
 * une étiquette signée publiée depuis sept jours au moins (§ 10.1).
 */

import './silence';
import { DurableObject } from 'cloudflare:workers';
import { BoxRuntime, type RawStorage } from './box';
import { Directory, DirectoryClient, directoryStub, handleDirectoryRequest } from './directory';
import { apiUrlOf, euNamespace, userAgent, type HostEnv } from './env';
import { handleFront } from './front';
import { HostApi } from './hostApi';
import { loadKeyring, signingKey } from './keys';
import { opsError } from './ops';
import { announcement } from './version';

const boxStub = (env: HostEnv, accessId: string): DurableObjectStub => {
  const ns = euNamespace(env.GATE_BOX, env);
  return ns.get(ns.idFromName(accessId));
};

export default {
  fetch(request: Request, env: HostEnv): Promise<Response> {
    return handleFront(request, env, {
      directory: new DirectoryClient(() => directoryStub(env)),
      box: (accessId) => boxStub(env, accessId),
    });
  },

  async scheduled(_controller: ScheduledController, env: HostEnv, ctx: ExecutionContext): Promise<void> {
    const a = announcement(env, loadKeyring(env), Date.now());
    if (!a) return;
    ctx.waitUntil(
      new DirectoryClient(() => directoryStub(env))
        .announce(a)
        .then(() => undefined)
        .catch(() => opsError('announce_failed'))
    );
  },
};

export class GateBox extends DurableObject<HostEnv> {
  private readonly runtime: BoxRuntime;

  constructor(ctx: DurableObjectState, env: HostEnv) {
    super(ctx, env);
    this.runtime = new BoxRuntime({
      storage: ctx.storage as unknown as RawStorage,
      waitUntil: (p) => ctx.waitUntil(p),
      env,
      directory: new DirectoryClient(() => directoryStub(env)),
    });
  }

  override fetch(request: Request): Promise<Response> {
    return this.runtime.fetch(request);
  }

  override alarm(): Promise<void> {
    return this.runtime.alarm();
  }
}

export class GateDirectory extends DurableObject<HostEnv> {
  private readonly directory: Directory;

  constructor(ctx: DurableObjectState, env: HostEnv) {
    super(ctx, env);
    const apiUrl = apiUrlOf(env);
    const ring = loadKeyring(env);
    const api = apiUrl ? new HostApi(apiUrl, () => signingKey(ring, Date.now()), userAgent) : null;
    this.directory = new Directory(ctx.storage as unknown as RawStorage, api ? async (a) => void (await api.version(a)) : null);
  }

  override fetch(request: Request): Promise<Response> {
    return handleDirectoryRequest(this.directory, request);
  }
}
