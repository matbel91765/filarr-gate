/**
 * Ce que le service hébergé demande en plus au moteur Workers (les déclarations de base sont
 * celles de `packages/cloudflare/src/workers.d.ts`, fusionnées ici) : la juridiction des objets
 * durables, l'effacement complet du stockage d'un objet, le déclencheur planifié.
 */

interface DurableObjectNamespace<T = unknown> {
  /** Un espace de noms dont les objets sont CRÉÉS dans cette juridiction (stockage et exécution). */
  jurisdiction(name: 'eu' | 'fedramp'): DurableObjectNamespace<T>;
}

interface DurableObjectStorage {
  /** Efface tout le stockage de l'objet (les alarmes à part). */
  deleteAll(): Promise<void>;
  deleteAlarm(): Promise<void>;
}

interface ScheduledController {
  readonly scheduledTime: number;
  readonly cron: string;
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}
