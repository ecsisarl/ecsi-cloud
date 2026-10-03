import { describe, expect, it } from 'vitest';
import { diff, REDACTED, sanitizeDetails, sanitizeRecord } from './sanitize.js';

describe("Nettoyage des détails d'audit", () => {
  it('masque toute clé évoquant un secret, à toute profondeur', () => {
    const result = sanitizeRecord({
      email: 'a@b.ci',
      password: 'x',
      newPassword: 'x',
      refresh_token: 'x',
      accessToken: 'x',
      cookie: 'x',
      totpSecret: 'x',
      secret_enc: 'x',
      encryptionKey: 'x',
      api_key: 'x',
      privateKey: 'x',
      recoveryCodes: ['x'],
      passwordHash: 'x',
      nested: { deeper: [{ wireguardPrivateKey: 'x', radiusSecret: 'x', name: 'ok' }] },
    });
    const text = JSON.stringify(result);
    expect(text).not.toMatch(/"x"/);
    expect(result.email).toBe('a@b.ci');
    expect(result.password).toBe(REDACTED);
    expect(result.nested).toEqual({
      deeper: [{ wireguardPrivateKey: REDACTED, radiusSecret: REDACTED, name: 'ok' }],
    });
  });

  it('borne la taille des chaînes, tableaux et la profondeur', () => {
    expect((sanitizeDetails('a'.repeat(600)) as string).length).toBe(501);
    expect((sanitizeDetails(Array.from({ length: 80 }, (_, i) => i)) as unknown[]).length).toBe(50);
    const deep = { a: { b: { c: { d: { e: { f: 1 } } } } } };
    expect(JSON.stringify(sanitizeDetails(deep))).toContain('[…]');
    expect(sanitizeRecord(undefined)).toEqual({});
  });

  it('ne garde que les champs modifiés (avant / après)', () => {
    const when = new Date('2026-10-03T10:00:00Z');
    expect(
      diff(
        { name: 'A', city: null, at: when, same: 1 },
        { name: 'B', city: 'Abidjan', at: new Date(when), same: 1 },
      ),
    ).toEqual({
      name: { before: 'A', after: 'B' },
      city: { before: null, after: 'Abidjan' },
    });
  });
});
