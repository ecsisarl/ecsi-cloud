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

  it('ne permet d’agir sur un membre que si l’on couvre tous ses droits (anti-escalade)', () => {
    const gerantSiteA = new Grants(
      ['GERANT'],
      new Set(),
      new Map([[SITE_A, new Set(['users.read', 'users.update', 'sales.read'] as const)]]),
    );
    const vendeurSiteA = new Grants(
      ['VENDEUR'],
      new Set(),
      new Map([[SITE_A, new Set(['sales.read'] as const)]]),
    );
    const vendeurSiteB = new Grants(
      ['VENDEUR'],
      new Set(),
      new Map([[SITE_B, new Set(['sales.read'] as const)]]),
    );
    const admin = new Grants(
      ['ADMIN_ENTREPRISE'],
      new Set(['users.update', 'sales.read', 'users.read']),
      new Map(),
    );

    expect(gerantSiteA.covers(vendeurSiteA)).toBe(true);
    expect(gerantSiteA.hasOverMember('users.update', vendeurSiteA)).toBe(true);
    // Vendeur d'un autre site : hors portée.
    expect(gerantSiteA.covers(vendeurSiteB)).toBe(false);
    expect(gerantSiteA.hasOverMember('users.update', vendeurSiteB)).toBe(false);
    // Membre à portée entreprise : jamais administrable par un gérant de site.
    expect(gerantSiteA.covers(admin)).toBe(false);
    expect(gerantSiteA.hasOverMember('users.update', admin)).toBe(false);
    expect(gerantSiteA.hasOverMember('users.update', Grants.empty())).toBe(false);
    // L'administrateur couvre tout le monde.
    expect(admin.hasOverMember('users.update', vendeurSiteB)).toBe(true);
    expect(admin.covers(gerantSiteA)).toBe(true);
  });
});
