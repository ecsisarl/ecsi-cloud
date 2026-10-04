import { describe, expect, it } from 'vitest';
import {
  enrollRequestSchema,
  registerRouterRequestSchema,
  routerCredentialsRequestSchema,
  updateRouterRequestSchema,
  WIREGUARD_PUBLIC_KEY,
} from './routers.js';

const KEY = 'devonlyWireGuardPublicKeyForTests000000000A=';

describe('schémas des routeurs (Sprint 3B)', () => {
  it('enrôlement public : jeton et clé publique, rien d’autre', () => {
    expect(enrollRequestSchema.safeParse({ token: 'a'.repeat(43), publicKey: KEY }).success).toBe(
      true,
    );
    for (const body of [
      { token: 'a'.repeat(43), publicKey: KEY, privateKey: KEY },
      { token: 'a'.repeat(42), publicKey: KEY },
      { token: 'a'.repeat(43), publicKey: 'pas une clé' },
      { token: `${'a'.repeat(42)}"`, publicKey: KEY },
    ]) {
      expect(enrollRequestSchema.safeParse(body).success).toBe(false);
    }
  });

  it('clé publique WireGuard : 32 octets en base64', () => {
    expect(WIREGUARD_PUBLIC_KEY.test(KEY)).toBe(true);
    expect(WIREGUARD_PUBLIC_KEY.test(`${KEY.slice(0, 42)}B=`)).toBe(false); // bits de bourrage
    expect(WIREGUARD_PUBLIC_KEY.test(KEY.slice(1))).toBe(false);
  });

  it('identifiants : empreinte normalisée, mot de passe d’au moins 12 caractères', () => {
    const parsed = routerCredentialsRequestSchema.parse({
      routerosUsername: 'ecsi-svc',
      routerosPassword: 'x'.repeat(12),
      tlsFingerprint: 'AB:'.repeat(31) + 'AB',
    });
    expect(parsed.tlsFingerprint).toBe('ab'.repeat(32));
    expect(
      routerCredentialsRequestSchema.safeParse({
        routerosUsername: 'a b',
        routerosPassword: 'x'.repeat(12),
      }).success,
    ).toBe(false);
    expect(
      routerCredentialsRequestSchema.safeParse({ routerosUsername: 'a', routerosPassword: 'court' })
        .success,
    ).toBe(false);
  });

  it('enregistrement manuel strict ; modification non vide', () => {
    expect(
      registerRouterRequestSchema.safeParse({
        siteId: '0199b000-0000-7000-8000-000000000001',
        name: 'CHR-LAB',
        tunnelIp: '10.200.0.2',
        transport: 'API',
        routerosUsername: 'ecsi-cloud',
        routerosPassword: 'x'.repeat(16),
        companyId: '0199b000-0000-7000-8000-000000000002',
      }).success,
    ).toBe(false);
    expect(updateRouterRequestSchema.safeParse({}).success).toBe(false);
    expect(updateRouterRequestSchema.safeParse({ name: 'Riviera' }).success).toBe(true);
  });
});
