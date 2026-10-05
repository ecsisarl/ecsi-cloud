// Fonctions pures du pilote S3B (testées par pilote.test.mjs, sans réseau ni API).

/** Erreur API : statut HTTP et message de l'API (format problème RFC 9457), jamais de secret. */
export class ApiError extends Error {
  constructor(label, status, detail) {
    super(`${label} : HTTP ${status}${detail ? ` (${detail})` : ''}`);
    this.name = 'ApiError';
    this.status = status;
  }
}

/** Message lisible d'une réponse d'erreur : detail, title, ou rien. */
export function problemDetail(json) {
  if (json && typeof json === 'object') {
    if (typeof json.detail === 'string') return json.detail;
    if (typeof json.title === 'string') return json.title;
  }
  return '';
}

/** Lève une ApiError si le statut n'est pas l'un de ceux attendus. */
export function expectStatus(response, expected, label) {
  const allowed = Array.isArray(expected) ? expected : [expected];
  if (!allowed.includes(response.status)) {
    throw new ApiError(label, response.status, problemDetail(response.json));
  }
  return response.json;
}

/** Corps JSON d'une réponse, ou null (corps vide ou non JSON, ex. page d'erreur d'un proxy). */
export function parseBody(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Vue « voir » d'un routeur : interfaces résumées ; tolère l'absence d'instantané. */
export function routerView(router) {
  const { interfaces, ...rest } = router;
  return {
    ...rest,
    interfaces: Array.isArray(interfaces)
      ? interfaces.map((i) => `${i.name}:${i.running ? 'up' : 'down'}`)
      : [],
  };
}
