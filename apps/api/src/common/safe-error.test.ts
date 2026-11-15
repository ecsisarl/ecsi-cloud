import { DrizzleQueryError } from 'drizzle-orm/errors';
import { describe, expect, it } from 'vitest';
import { safeError, safeErrorMessage } from './safe-error.js';

const SENSITIVE = ['gerant@ecsi.test', '$argon2id$v=19$m=19456', 'v1:k3:Y2lwaGVy'];

function pgError(): Error {
  // Forme d'un pg.DatabaseError (champs publics de la bibliothèque pg).
  return Object.assign(new Error('duplicate key value violates unique constraint "users_email"'), {
    name: 'error',
    code: '23505',
    severity: 'ERROR',
    table: 'users',
    constraint: 'users_email',
    detail: `Key (email)=(${SENSITIVE[0]}) already exists.`,
    where: `SQL statement with ${SENSITIVE[1]}`,
  });
}

describe('safeError', () => {
  it('retire les paramètres SQL d’une erreur Drizzle (message, pile, champ params, cause)', () => {
    const error = new DrizzleQueryError(
      'insert into "users" ("email", "password_hash", "totp") values ($1, $2, $3)',
      SENSITIVE,
      pgError(),
    );
    const safe = safeError(error);
    const serialized = JSON.stringify(safe);
    for (const value of SENSITIVE) expect(serialized).not.toContain(value);
    expect(safe.query).toContain('values ($1, $2, $3)');
    expect(safe.message).toContain('params: [masqués]');
    expect(safe.stack).toContain('params: [masqués]');
    expect(safe.cause).toMatchObject({ code: '23505', table: 'users', constraint: 'users_email' });
    expect(safeErrorMessage(error)).not.toContain(SENSITIVE[0]);
    expect(safeErrorMessage(error)).toContain('users_email');
  });

  it('conserve une erreur ordinaire et accepte les valeurs non-Error', () => {
    expect(safeError(new Error('délai dépassé'))).toMatchObject({
      type: 'Error',
      message: 'délai dépassé',
    });
    expect(safeError('texte')).toEqual({ type: 'string', message: '[valeur non-Error]' });
    expect(safeErrorMessage(new Error('x'))).toBe('x');
  });

  it('est idempotent (erreur déjà sérialisée ou déjà nettoyée)', () => {
    const error = new DrizzleQueryError('select $1', [SENSITIVE[0]], pgError());
    const once = safeError(error);
    const twice = safeError(JSON.parse(JSON.stringify(once)));
    expect(twice).toEqual(once);
    const serializedByPino = {
      type: 'DrizzleQueryError',
      message: error.message,
      stack: error.stack,
      params: [SENSITIVE[0]],
    };
    expect(JSON.stringify(safeError(serializedByPino))).not.toContain(SENSITIVE[0]);
  });
});
