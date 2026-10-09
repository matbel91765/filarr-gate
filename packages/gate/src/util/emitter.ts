/** Un émetteur d'événements minimal, sans `node:events` (Workers, Deno, Bun). */

type Listener = (...args: any[]) => void; // eslint-disable-line @typescript-eslint/no-explicit-any

export class Emitter {
  private listeners = new Map<string, Set<Listener>>();

  on(event: string, fn: Listener): this {
    let set = this.listeners.get(event);
    if (!set) this.listeners.set(event, (set = new Set()));
    set.add(fn);
    return this;
  }

  off(event: string, fn: Listener): this {
    this.listeners.get(event)?.delete(fn);
    return this;
  }

  once(event: string, fn: Listener): this {
    const wrapped: Listener = (...args) => {
      this.off(event, wrapped);
      fn(...args);
    };
    return this.on(event, wrapped);
  }

  emit(event: string, ...args: unknown[]): boolean {
    const set = this.listeners.get(event);
    if (!set || set.size === 0) return false;
    for (const fn of [...set]) {
      try {
        fn(...args);
      } catch {
        /* un écouteur fautif ne casse pas la réplique */
      }
    }
    return true;
  }

  removeAllListeners(): void {
    this.listeners.clear();
  }
}
