/**
 * L'erreur de la boîte noire : un `code` stable (le même que celui de l'API
 * locale de Filarr Gate, ou celui de Filarr quand il vient de Filarr), un
 * `status` HTTP équivalent, et des précisions (`retryAfter`, `limit`, `keys`…).
 * La bibliothèque l'exporte sous le nom `GateError`.
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly extra: Record<string, unknown> = {}
  ) {
    super(message);
    this.name = 'GateError';
  }
}
