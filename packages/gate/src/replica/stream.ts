/**
 * Le flux des changements (`GET /api-access/self/stream`, WebSocket), selon le
 * moteur qui fait tourner la boîte noire.
 *
 * L'en-tête `Authorization: Filarr-Access …` est exigé à la montée : le
 * constructeur `WebSocket` des navigateurs ne sait pas le poser. D'où trois façons :
 *  - **Workers** (Cloudflare) : `fetch(url, { headers: { Upgrade: "websocket" } })`,
 *    qui rend aussi le refus entier (statut, corps) quand la montée échoue ;
 *  - **paquet `ws`** (Node 20 et plus, injecté par le serveur) : il pose les
 *    en-têtes et rend le refus entier (`unexpected-response`) ;
 *  - **`WebSocket` standard** qui accepte des en-têtes (Node 22 et plus, Deno,
 *    Bun) : un refus n'y est qu'une erreur sans statut ; la boîte demande alors
 *    la même route SANS montée, et la porte de Filarr rend son refus (`403
 *    api_tier_stream`, `429 api_quota_sync`…) ou `426 websocket_required` quand le
 *    flux aurait été accepté (la coupure était passagère).
 */

export interface StreamSocket {
  send(text: string): void;
  close(code?: number, reason?: string): void;
  /** Coupe sans poignée de main (réseau perdu, arrêt). */
  terminate(): void;
}

export interface StreamHandlers {
  onOpen(): void;
  onMessage(text: string): void;
  onClose(code: number, reason: string): void;
}

export interface StreamRefusal {
  status: number;
  code: string;
  retryAfter: string | null;
}

export type StreamOutcome = { socket: StreamSocket } | { refused: StreamRefusal };

/** Ouvre le flux ; ne lève pas : un échec de réseau rend `{ refused: { status: 0 } }`. */
export type StreamOpener = (url: URL, headers: Record<string, string>, handlers: StreamHandlers) => Promise<StreamOutcome>;

const HANDSHAKE_MS = 15_000;

async function refusalOf(res: Response): Promise<StreamRefusal> {
  let code = `http_${res.status}`;
  try {
    const parsed = (await res.json()) as { code?: unknown };
    if (typeof parsed.code === 'string') code = parsed.code;
  } catch {
    /* corps illisible : le statut suffit */
  }
  return { status: res.status, code, retryAfter: res.headers.get('retry-after') };
}

const httpUrl = (url: URL): string => url.toString().replace(/^ws(s?):/, 'http$1:');

interface WorkersSocket {
  accept(): void;
  send(text: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: string, fn: (ev: { data?: unknown; code?: number; reason?: string }) => void): void;
}

/** Workers : la montée par `fetch`, qui rend le refus entier. */
export function fetchUpgradeOpener(fetchImpl: typeof fetch = fetch): StreamOpener {
  return async (url, headers, h) => {
    let res: Response;
    try {
      res = await fetchImpl(httpUrl(url), { headers: { ...headers, Upgrade: 'websocket' } });
    } catch {
      return { refused: { status: 0, code: 'unreachable', retryAfter: null } };
    }
    const ws = (res as unknown as { webSocket?: WorkersSocket | null }).webSocket;
    if (res.status !== 101 || !ws) return { refused: await refusalOf(res) };
    ws.accept();
    let closed = false;
    ws.addEventListener('message', (ev) => h.onMessage(typeof ev.data === 'string' ? ev.data : ''));
    ws.addEventListener('close', (ev) => {
      if (closed) return;
      closed = true;
      h.onClose(ev.code ?? 1006, ev.reason ?? '');
    });
    ws.addEventListener('error', () => {
      if (closed) return;
      closed = true;
      h.onClose(1006, '');
    });
    queueMicrotask(() => h.onOpen());
    return {
      socket: {
        send: (t) => ws.send(t),
        close: (code, reason) => ws.close(code, reason),
        terminate: () => {
          try {
            ws.close(1000, 'bye');
          } catch {
            /* déjà fermé */
          }
          if (!closed) {
            closed = true;
            h.onClose(1006, '');
          }
        },
      },
    };
  };
}

/** Le minimum du paquet `ws` dont la boîte se sert (sans dépendre de ses types). */
export interface WsLike {
  on(event: 'open', fn: () => void): void;
  on(event: 'message', fn: (data: { toString(): string }) => void): void;
  on(event: 'close', fn: (code: number, reason: { toString(enc?: string): string }) => void): void;
  on(event: 'error', fn: (err: Error) => void): void;
  on(
    event: 'unexpected-response',
    fn: (req: unknown, res: { statusCode?: number; headers: Record<string, string | string[] | undefined>; on(ev: string, fn: (chunk?: { toString(): string }) => void): void }) => void
  ): void;
  send(text: string): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
}
export type WsCtor = new (url: URL | string, opts: { headers: Record<string, string>; handshakeTimeout?: number }) => WsLike;

/** Node, paquet `ws` : en-têtes posés, refus entier. */
export function wsPackageOpener(WebSocketCtor: WsCtor): StreamOpener {
  return (url, headers, h) =>
    new Promise<StreamOutcome>((resolve) => {
      let ws: WsLike;
      try {
        ws = new WebSocketCtor(url, { headers, handshakeTimeout: HANDSHAKE_MS });
      } catch {
        resolve({ refused: { status: 0, code: 'unreachable', retryAfter: null } });
        return;
      }
      let opened = false;
      let settled = false;
      const settle = (o: StreamOutcome) => {
        if (!settled) {
          settled = true;
          resolve(o);
        }
      };
      ws.on('unexpected-response', (_req, res) => {
        let text = '';
        res.on('data', (chunk) => (text += chunk?.toString() ?? ''));
        res.on('end', () => {
          let code = `http_${res.statusCode ?? 0}`;
          try {
            const parsed = JSON.parse(text) as { code?: unknown };
            if (typeof parsed.code === 'string') code = parsed.code;
          } catch {
            /* corps illisible */
          }
          const ra = res.headers['retry-after'];
          ws.terminate();
          settle({ refused: { status: res.statusCode ?? 0, code, retryAfter: Array.isArray(ra) ? (ra[0] ?? null) : (ra ?? null) } });
        });
      });
      ws.on('open', () => {
        opened = true;
        settle({ socket: { send: (t) => ws.send(t), close: (c, r) => ws.close(c, r), terminate: () => ws.terminate() } });
        h.onOpen();
      });
      ws.on('message', (data) => h.onMessage(data.toString()));
      ws.on('close', (code, reason) => {
        if (!opened) settle({ refused: { status: 0, code: 'closed', retryAfter: null } });
        else h.onClose(code, reason.toString('utf8'));
      });
      ws.on('error', () => {
        /* la fermeture suit */
      });
    });
}

type StandardCtor = new (url: string, opts: { headers: Record<string, string> }) => {
  onopen: (() => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number; reason: string }) => void) | null;
  onerror: (() => void) | null;
  send(text: string): void;
  close(code?: number, reason?: string): void;
};

/**
 * `WebSocket` standard qui accepte des en-têtes (Node 22 et plus, Deno, Bun).
 * Un refus de montée se relit par la même route sans montée (voir l'en-tête).
 */
export function standardOpener(Ctor: StandardCtor, fetchImpl: typeof fetch = fetch): StreamOpener {
  return (url, headers, h) =>
    new Promise<StreamOutcome>((resolve) => {
      let opened = false;
      let settled = false;
      const settle = (o: StreamOutcome) => {
        if (!settled) {
          settled = true;
          resolve(o);
        }
      };
      let ws: InstanceType<StandardCtor>;
      try {
        ws = new Ctor(url.toString(), { headers });
      } catch {
        settle({ refused: { status: 0, code: 'unreachable', retryAfter: null } });
        return;
      }
      const timer = setTimeout(() => {
        if (!opened) {
          try {
            ws.close();
          } catch {
            /* rien */
          }
          settle({ refused: { status: 0, code: 'handshake_timeout', retryAfter: null } });
        }
      }, HANDSHAKE_MS);
      const probe = async () => {
        try {
          const res = await fetchImpl(httpUrl(url), { headers, signal: AbortSignal.timeout(10_000) });
          if (res.status === 426) {
            await res.arrayBuffer().catch(() => undefined);
            return settle({ refused: { status: 0, code: 'closed', retryAfter: null } });
          }
          settle({ refused: await refusalOf(res) });
        } catch {
          settle({ refused: { status: 0, code: 'unreachable', retryAfter: null } });
        }
      };
      let probing = false;
      const probeOnce = () => {
        if (probing) return;
        probing = true;
        void probe();
      };
      let closeFired = false;
      const fireClose = (code: number, reason: string) => {
        if (closeFired) return;
        closeFired = true;
        h.onClose(code, reason);
      };
      ws.onopen = () => {
        opened = true;
        clearTimeout(timer);
        settle({
          socket: {
            send: (t) => ws.send(t),
            close: (c, r) => ws.close(c, r),
            terminate: () => {
              try {
                ws.close();
              } catch {
                /* déjà fermé */
              }
              fireClose(1006, '');
            },
          },
        });
        h.onOpen();
      };
      ws.onmessage = (ev) => h.onMessage(typeof ev.data === 'string' ? ev.data : String(ev.data));
      ws.onerror = () => {
        if (!opened) {
          clearTimeout(timer);
          if (!settled) probeOnce();
        }
      };
      ws.onclose = (ev) => {
        clearTimeout(timer);
        if (!opened) {
          if (!settled) probeOnce();
          return;
        }
        fireClose(ev.code, ev.reason);
      };
    });
}

/** Le meilleur moyen disponible ici ; `null` : pas de flux, la boîte relève. */
export function defaultStreamOpener(fetchImpl: typeof fetch = fetch): StreamOpener | null {
  const g = globalThis as unknown as { WebSocketPair?: unknown; WebSocket?: StandardCtor };
  if (g.WebSocketPair !== undefined) return fetchUpgradeOpener(fetchImpl);
  if (typeof g.WebSocket === 'function') return standardOpener(g.WebSocket, fetchImpl);
  return null;
}
