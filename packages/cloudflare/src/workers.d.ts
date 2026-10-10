/**
 * Le peu du moteur Workers dont la boîte a besoin, déclaré ici : le code partagé
 * se vérifie avec les types du DOM (comme sous Node), que ceux de
 * `@cloudflare/workers-types` contredisent (`crypto`, `Request`…).
 */

interface DurableObjectId {
  toString(): string;
}

interface DurableObjectStub {
  fetch(request: Request): Promise<Response>;
}

interface DurableObjectNamespace<T = unknown> {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): DurableObjectStub & { readonly __object?: T };
}

interface DurableObjectStorage {
  get<T = unknown>(key: string): Promise<T | undefined>;
  get<T = unknown>(keys: string[]): Promise<Map<string, T>>;
  put<T>(key: string, value: T): Promise<void>;
  put<T>(entries: Record<string, T>): Promise<void>;
  delete(key: string): Promise<boolean>;
  delete(keys: string[]): Promise<number>;
  list<T = unknown>(options?: { prefix?: string; start?: string; end?: string; limit?: number }): Promise<Map<string, T>>;
  getAlarm(): Promise<number | null>;
  setAlarm(at: number | Date): Promise<void>;
}

interface DurableObjectState {
  readonly storage: DurableObjectStorage;
  waitUntil(promise: Promise<unknown>): void;
  blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T>;
}

interface Fetcher {
  fetch(request: Request): Promise<Response>;
}

interface ExportedHandler<Env = unknown> {
  fetch?(request: Request, env: Env, ctx: { waitUntil(p: Promise<unknown>): void }): Promise<Response>;
}

declare module 'cloudflare:workers' {
  export abstract class DurableObject<Env = unknown> {
    protected readonly ctx: DurableObjectState;
    protected readonly env: Env;
    constructor(ctx: DurableObjectState, env: Env);
    fetch?(request: Request): Promise<Response>;
    alarm?(): Promise<void>;
  }
}
