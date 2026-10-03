import { describe, expect, it } from 'vitest';
import { Grants } from './access.service.js';

const SITE_A = '0190a0f0-0000-7000-8000-00000000000a';
const SITE_B = '0190a0f0-0000-7000-8000-00000000000b';

describe('Grants (portée entreprise / sites)', () => {
  const grants = new Grants(
    ['TECHNICIEN'],
    new Set(['users.read']),
    new Map([[SITE_A, new Set(['routers.read', 'routers.update'] as const)]]),
  );

  it('distingue la portée entreprise de la portée site', () => {
    expect(grants.hasCompanyWide('users.read')).toBe(true);
    expect(grants.hasCompanyWide('routers.read')).toBe(false);
    expect(grants.hasForSite('routers.read', SITE_A)).toBe(true);
    expect(grants.hasForSite('routers.read', SITE_B)).toBe(false);
    expect(grants.hasForSite('users.read', SITE_B)).toBe(true);
    expect(grants.sitesFor('routers.read')).toEqual([SITE_A]);
    expect(grants.sitesFor('users.read')).toBe('ALL');
    expect(grants.all()).toEqual(['routers.read', 'routers.update', 'users.read']);
  });

  it('interdit d’accorder plus que ce que l’on détient', () => {
    expect(grants.canGrant(['users.read'], 'COMPANY', [])).toBe(true);
    expect(grants.canGrant(['routers.read'], 'COMPANY', [])).toBe(false);
    expect(grants.canGrant(['routers.read'], 'SITES', [SITE_A])).toBe(true);
    expect(grants.canGrant(['routers.read'], 'SITES', [SITE_A, SITE_B])).toBe(false);
    expect(grants.canGrant(['permission.inexistante'], 'COMPANY', [])).toBe(false);
    expect(Grants.empty().canGrant(['users.read'], 'COMPANY', [])).toBe(false);
  });
});
