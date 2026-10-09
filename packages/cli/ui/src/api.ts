/** L'API d'administration de la boîte noire (`/admin/api`). */

export class ApiFailure extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly body: Record<string, unknown> = {}
  ) {
    super(message);
  }
}

let onUnauthorized: (() => void) | null = null;

export function whenUnauthorized(fn: () => void): void {
  onUnauthorized = fn;
}

export async function api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/admin/api${path}`, {
    method,
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json',
      ...(method !== 'GET' ? { 'X-Gate-Admin': '1', 'Content-Type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  let parsed: Record<string, unknown> = {};
  try {
    parsed = (await res.json()) as Record<string, unknown>;
  } catch {
    /* corps vide */
  }
  if (!res.ok) {
    if (res.status === 401 && parsed.code === 'login_required') onUnauthorized?.();
    throw new ApiFailure(res.status, String(parsed.code ?? `http_${res.status}`), String(parsed.error ?? res.statusText), parsed);
  }
  return parsed as T;
}

/** Télécharge un contenu comme fichier. */
export function download(name: string, content: BlobPart, type: string): void {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
