import { describe, expect, it } from 'vitest';
import { AUDIT_FORBIDDEN_KEY, listAuditQuerySchema } from './audit.js';
import {
  createCompanyRequestSchema,
  isValidTimezone,
  slugify,
  updateCompanyProfileRequestSchema,
} from './company.js';
import { createSiteRequestSchema, siteMetadataSchema, updateSiteRequestSchema } from './sites.js';

describe('schémas du Sprint 2', () => {
  it('entreprise : valeurs par défaut CI / XOF / fr / Africa/Abidjan', () => {
    const parsed = createCompanyRequestSchema.parse({ name: 'Wifi Zone', adminEmail: 'A@B.CI' });
    expect(parsed).toMatchObject({
      country: 'CI',
      currency: 'XOF',
      locale: 'fr',
      timezone: 'Africa/Abidjan',
      adminEmail: 'a@b.ci',
    });
    expect(slugify('Wifi Zone Bouaké — Centre')).toBe('wifi-zone-bouake-centre');
    expect(isValidTimezone('Africa/Dakar')).toBe(true);
    expect(isValidTimezone('Mars/Olympus')).toBe(false);
  });

  it('profil : le statut et l’identifiant ne font pas partie des champs modifiables', () => {
    const base = {
      name: 'A',
      legalName: null,
      phone: null,
      whatsapp: null,
      email: null,
      address: null,
      city: null,
      country: 'CI',
      currency: 'XOF',
      locale: 'fr',
      timezone: 'UTC',
    };
    expect(updateCompanyProfileRequestSchema.safeParse({ ...base, name: 'AB' }).success).toBe(true);
    expect(
      updateCompanyProfileRequestSchema.safeParse({ ...base, name: 'AB', status: 'ACTIVE' })
        .success,
    ).toBe(false);
  });

  it('site : code normalisé, coordonnées ensemble, métadonnées sans secret', () => {
    const site = createSiteRequestSchema.parse({
      name: 'Cocody',
      code: 'site-a',
      country: 'CI',
      timezone: 'Africa/Abidjan',
    });
    expect(site).toMatchObject({ code: 'SITE-A', status: 'ACTIVE', metadata: {} });
    expect(
      createSiteRequestSchema.safeParse({ ...site, latitude: 5.3, longitude: null }).success,
    ).toBe(false);
    expect(siteMetadataSchema.safeParse({ routeur_password: 'x' }).success).toBe(false);
    expect(siteMetadataSchema.safeParse({ borne: 'B1' }).success).toBe(true);
  });

  it('modification partielle d’un site : aucune valeur par défaut réinjectée', () => {
    expect(updateSiteRequestSchema.parse({ name: 'Nouveau nom' })).toEqual({ name: 'Nouveau nom' });
  });

  it('audit : clés sensibles reconnues, filtres bornés', () => {
    for (const key of ['password', 'refreshToken', 'cookie', 'totpSecret', 'privateKey', 'api_key'])
      expect(AUDIT_FORBIDDEN_KEY.test(key), key).toBe(true);
    for (const key of ['email', 'name', 'siteId', 'reason'])
      expect(AUDIT_FORBIDDEN_KEY.test(key), key).toBe(false);
    expect(listAuditQuerySchema.parse({}).limit).toBe(25);
    expect(listAuditQuerySchema.safeParse({ limit: '500' }).success).toBe(false);
  });
});
