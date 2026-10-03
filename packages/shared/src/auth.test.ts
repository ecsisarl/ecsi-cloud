import { describe, expect, it } from 'vitest';
import {
  createInvitationRequestSchema,
  loginRequestSchema,
  recoveryCodeSchema,
  resetPasswordRequestSchema,
} from './auth.js';

describe('schémas d’authentification', () => {
  it('normalise l’adresse e-mail', () => {
    expect(loginRequestSchema.parse({ email: ' Awa@Exemple.CI ', password: 'x' }).email).toBe(
      'awa@exemple.ci',
    );
  });

  it('refuse toute clé inconnue, notamment un companyId fourni par le client', () => {
    const result = loginRequestSchema.safeParse({
      email: 'a@exemple.ci',
      password: 'x',
      companyId: '0190a0f0-0000-7000-8000-000000000000',
    });
    expect(result.success).toBe(false);
  });

  it('impose une longueur de mot de passe à la réinitialisation', () => {
    const token = 'a'.repeat(43);
    expect(resetPasswordRequestSchema.safeParse({ token, password: 'court' }).success).toBe(false);
    expect(resetPasswordRequestSchema.safeParse({ token, password: 'x'.repeat(129) }).success).toBe(
      false,
    );
    expect(
      resetPasswordRequestSchema.safeParse({ token, password: 'une phrase de passe longue' })
        .success,
    ).toBe(true);
  });

  it('normalise les codes de récupération', () => {
    expect(recoveryCodeSchema.parse('abcde-12345')).toBe('ABCDE12345');
  });

  it('exige des sites pour une portée SITES et les interdit pour COMPANY', () => {
    const roleId = '0190a0f0-0000-7000-8000-000000000001';
    const siteId = '0190a0f0-0000-7000-8000-000000000002';
    const parse = (roles: unknown) =>
      createInvitationRequestSchema.safeParse({ email: 'b@exemple.ci', roles }).success;
    expect(parse([{ roleId }])).toBe(true);
    expect(parse([{ roleId, scope: 'SITES' }])).toBe(false);
    expect(parse([{ roleId, scope: 'SITES', siteIds: [siteId] }])).toBe(true);
    expect(parse([{ roleId, scope: 'COMPANY', siteIds: [siteId] }])).toBe(false);
  });
});
