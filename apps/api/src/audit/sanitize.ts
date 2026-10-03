import { AUDIT_FORBIDDEN_KEY } from '@ecsi/shared';

const MAX_DEPTH = 5;
const MAX_STRING = 500;
const MAX_ENTRIES = 50;
export const REDACTED = '[masqué]';

/**
 * Nettoie les détails d'un événement d'audit avant écriture : toute clé évoquant un secret
 * (mot de passe, jeton, cookie, secret TOTP, clé, empreinte…) est remplacée par « [masqué] »,
 * à toute profondeur. Les chaînes, tableaux et objets sont bornés pour qu'un journal ne
 * devienne jamais un stockage de données arbitraires.
 */
export function sanitizeDetails(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') {
    return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (value instanceof Date) return value.toISOString();
  if (depth >= MAX_DEPTH) return '[…]';
  if (Array.isArray(value)) {
    return value.slice(0, MAX_ENTRIES).map((item) => sanitizeDetails(item, depth + 1));
  }
  if (typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value).slice(0, MAX_ENTRIES)) {
      result[key] = AUDIT_FORBIDDEN_KEY.test(key) ? REDACTED : sanitizeDetails(item, depth + 1);
    }
    return result;
  }
  // bigint, symbole, fonction : jamais d'objet ici (traité plus haut).
  return typeof value === 'bigint' ? value.toString() : typeof value;
}

export function sanitizeRecord(
  value: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const result = sanitizeDetails(value ?? {});
  return result && typeof result === 'object' && !Array.isArray(result)
    ? (result as Record<string, unknown>)
    : {};
}

/**
 * Différences entre deux états : uniquement les champs modifiés, sous la forme
 * { champ: { avant, après } }. Les dates sont comparées par valeur.
 */
export function diff(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  fields: readonly string[] = [...new Set([...Object.keys(before), ...Object.keys(after)])],
): Record<string, { before: unknown; after: unknown }> {
  const changes: Record<string, { before: unknown; after: unknown }> = {};
  for (const field of fields) {
    const a = normalize(before[field]);
    const b = normalize(after[field]);
    if (JSON.stringify(a) !== JSON.stringify(b)) changes[field] = { before: a, after: b };
  }
  return changes;
}

function normalize(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  return value ?? null;
}
