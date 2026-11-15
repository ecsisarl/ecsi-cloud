/**
 * Erreurs prêtes à journaliser, sans donnée : une erreur de requête Drizzle porte les
 * PARAMÈTRES SQL dans son message, sa pile et son champ `params` (hachés, adresses e-mail,
 * secrets chiffrés…) ; une erreur PostgreSQL porte les valeurs en cause dans `detail` et
 * `where`. Seuls le texte SQL (paramètres $1, $2…), le nom, le code et les métadonnées de
 * contrainte sont conservés.
 */
const PARAMS_LINE = /\nparams: [\s\S]*?(?=\n {4}at |$)/;

/** Champs PostgreSQL (pg.DatabaseError) sans valeur de donnée. */
const PG_FIELDS = [
  'code',
  'severity',
  'schema',
  'table',
  'column',
  'constraint',
  'routine',
] as const;

export interface SafeError {
  type: string;
  message: string;
  stack?: string;
  query?: string;
  code?: string;
  severity?: string;
  schema?: string;
  table?: string;
  column?: string;
  constraint?: string;
  routine?: string;
  cause?: SafeError;
}

function stripParams(text: string): string {
  return text.replace(PARAMS_LINE, '\nparams: [masqués]');
}

/** Error, ou objet qui en a la forme (erreur déjà sérialisée par pino : { type, message, stack }). */
function errorLike(value: unknown): (Record<string, unknown> & { message: string }) | null {
  if (value instanceof Error)
    return value as unknown as Record<string, unknown> & { message: string };
  if (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { message?: unknown }).message === 'string'
  ) {
    return value as Record<string, unknown> & { message: string };
  }
  return null;
}

export function safeError(error: unknown, depth = 0): SafeError {
  const record = errorLike(error);
  if (!record) return { type: typeof error, message: '[valeur non-Error]' };
  const name = error instanceof Error ? error.name : (record.type ?? record.name);
  const safe: SafeError = {
    type: typeof name === 'string' ? name : 'Error',
    message: stripParams(record.message),
  };
  if (typeof record.stack === 'string') safe.stack = stripParams(record.stack);
  if (typeof record.query === 'string') safe.query = record.query;
  for (const field of PG_FIELDS) {
    const value = record[field];
    if (typeof value === 'string') safe[field] = value;
  }
  if (record.cause !== undefined && depth < 3) safe.cause = safeError(record.cause, depth + 1);
  return safe;
}

/** Message d'une ligne, sans paramètre SQL (journaux texte du worker et de la passerelle). */
export function safeErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const message = stripParams(error.message);
  const cause =
    error.cause instanceof Error ? ` (cause : ${stripParams(error.cause.message)})` : '';
  return `${message}${cause}`;
}
