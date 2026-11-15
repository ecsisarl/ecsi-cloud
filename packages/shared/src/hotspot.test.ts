import { describe, expect, it } from 'vitest';
import {
  createHotspotRequestSchema,
  createPlanRequestSchema,
  createVoucherBatchRequestSchema,
  formatIpv4,
  hotspotNetworkIssues,
  isRfc1918Network,
  listRadiusSessionsQuerySchema,
  listVouchersQuerySchema,
  networksOverlap,
  parseIpv4,
  parseIpv4Cidr,
  planHasLimit,
  updateHotspotRequestSchema,
  updatePlanRequestSchema,
  voucherRemaining,
} from './hotspot.js';

const UUID = '0190a6b0-0000-7000-8000-000000000001';

describe('forfaits : mêmes règles que les contraintes de la base', () => {
  const base = { name: 'Pass 1 h', priceMinor: 200, sessionTimeSeconds: 3600 };

  it('valeurs par défaut : un appareil, cinq minutes d’inactivité', () => {
    expect(createPlanRequestSchema.parse(base)).toMatchObject({
      maxDevices: 1,
      idleTimeoutSeconds: 300,
    });
  });

  it('exige au moins une limite (validité, temps ou volume)', () => {
    expect(planHasLimit({})).toBe(false);
    expect(planHasLimit({ dataQuotaBytes: 1_048_576 })).toBe(true);
    const result = createPlanRequestSchema.safeParse({ name: 'Illimité', priceMinor: 0 });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toMatch(/au moins une limite/);
  });

  it.each([
    ['validitySeconds', 59],
    ['validitySeconds', 31_622_401],
    ['sessionTimeSeconds', 59],
    ['rateUpKbps', 7],
    ['rateDownKbps', 10_000_001],
    ['dataQuotaBytes', 1_048_575],
    ['dataQuotaBytes', 109_951_162_777_601],
    ['maxDevices', 0],
    ['maxDevices', 11],
    ['idleTimeoutSeconds', 59],
    ['idleTimeoutSeconds', 86_401],
    ['priceMinor', -1],
    ['priceMinor', 1.5],
  ])('refuse %s = %d', (field, value) => {
    expect(createPlanRequestSchema.safeParse({ ...base, [field]: value }).success).toBe(false);
  });

  it('accepte les bornes exactes', () => {
    expect(
      createPlanRequestSchema.safeParse({
        name: 'x',
        priceMinor: 0,
        validitySeconds: 31_622_400,
        sessionTimeSeconds: 60,
        rateUpKbps: 8,
        rateDownKbps: 10_000_000,
        dataQuotaBytes: 109_951_162_777_600,
        maxDevices: 10,
        idleTimeoutSeconds: 86_400,
      }).success,
    ).toBe(true);
  });

  it('nom de 1 à 80 caractères, champs inconnus refusés (pas de devise saisie)', () => {
    expect(createPlanRequestSchema.safeParse({ ...base, name: ' ' }).success).toBe(false);
    expect(createPlanRequestSchema.safeParse({ ...base, name: 'x'.repeat(81) }).success).toBe(
      false,
    );
    expect(createPlanRequestSchema.safeParse({ ...base, currency: 'EUR' }).success).toBe(false);
  });

  it('modification partielle sans valeur par défaut', () => {
    expect(updatePlanRequestSchema.parse({ priceMinor: 300 })).toEqual({ priceMinor: 300 });
    expect(updatePlanRequestSchema.safeParse({}).success).toBe(false);
    expect(updatePlanRequestSchema.parse({ dataQuotaBytes: null })).toEqual({
      dataQuotaBytes: null,
    });
  });
});

describe('lots de tickets', () => {
  it('quantité de 1 à 1000, libellé vide = aucun', () => {
    const ok = { planId: UUID, siteId: UUID, quantity: 1000, label: ' ' };
    expect(createVoucherBatchRequestSchema.parse(ok).label).toBeNull();
    expect(createVoucherBatchRequestSchema.safeParse({ ...ok, quantity: 0 }).success).toBe(false);
    expect(createVoucherBatchRequestSchema.safeParse({ ...ok, quantity: 1001 }).success).toBe(
      false,
    );
  });

  it('filtres de la liste : pagination bornée, numéro de série entier', () => {
    expect(listVouchersQuerySchema.parse({ serial: '12' })).toMatchObject({
      serial: 12,
      limit: 50,
      offset: 0,
    });
    expect(listVouchersQuerySchema.safeParse({ limit: '201' }).success).toBe(false);
    expect(listVouchersQuerySchema.safeParse({ code: 'abc' }).success).toBe(false);
  });

  it('sessions : active=true|false', () => {
    expect(listRadiusSessionsQuerySchema.parse({ active: 'true' }).active).toBe(true);
    expect(listRadiusSessionsQuerySchema.parse({ active: 'false' }).active).toBe(false);
    expect(listRadiusSessionsQuerySchema.safeParse({ active: 'oui' }).success).toBe(false);
  });
});

describe('consommation restante', () => {
  const voucher = {
    sessionTimeSeconds: 3600,
    usedSeconds: 600,
    dataQuotaBytes: 1000,
    usedBytes: 1500,
    expiresAt: '2026-01-01T01:00:00.000Z',
  };

  it('temps, volume (jamais négatif) et validité', () => {
    expect(voucherRemaining(voucher, new Date('2026-01-01T00:30:00Z'))).toEqual({
      sessionSeconds: 3000,
      bytes: 0,
      validitySeconds: 1800,
    });
  });

  it('limites absentes : null', () => {
    expect(
      voucherRemaining({
        sessionTimeSeconds: null,
        usedSeconds: 10,
        dataQuotaBytes: null,
        usedBytes: 0,
        expiresAt: null,
      }),
    ).toEqual({ sessionSeconds: null, bytes: null, validitySeconds: null });
  });
});

describe('réseau Hotspot', () => {
  it('analyse IPv4 et CIDR', () => {
    expect(parseIpv4('10.5.50.1')).toBe(0x0a053201);
    expect(formatIpv4(0x0a053201)).toBe('10.5.50.1');
    for (const bad of ['10.5.50', '256.1.1.1', '01.2.3.4', '1.2.3.4 ', 'a.b.c.d']) {
      expect(parseIpv4(bad), bad).toBeNull();
    }
    expect(parseIpv4Cidr('10.5.50.1/24')).toMatchObject({
      prefix: 24,
      network: parseIpv4('10.5.50.0'),
      broadcast: parseIpv4('10.5.50.255'),
    });
    expect(parseIpv4Cidr('10.5.50.1')).toBeNull();
    expect(parseIpv4Cidr('10.5.50.1/33')).toBeNull();
    expect(parseIpv4Cidr('10.5.50.1/2/4')).toBeNull();
  });

  it('plages privées RFC 1918 et chevauchement', () => {
    const net = (cidr: string) => parseIpv4Cidr(cidr)!;
    expect(isRfc1918Network(net('10.5.50.1/24'))).toBe(true);
    expect(isRfc1918Network(net('172.31.0.1/16'))).toBe(true);
    expect(isRfc1918Network(net('172.32.0.1/16'))).toBe(false);
    expect(isRfc1918Network(net('192.168.88.1/24'))).toBe(true);
    expect(isRfc1918Network(net('100.64.0.1/24'))).toBe(false);
    expect(isRfc1918Network(net('8.8.8.1/24'))).toBe(false);
    expect(networksOverlap(net('10.200.0.1/24'), net('10.200.0.0/16'))).toBe(true);
    expect(networksOverlap(net('10.5.50.1/24'), net('10.200.0.0/24'))).toBe(false);
  });

  const valid = { gatewayAddress: '10.5.50.1/24', poolStart: '10.5.50.10', poolEnd: '10.5.50.254' };

  it('configuration valide', () => {
    expect(hotspotNetworkIssues(valid)).toEqual([]);
  });

  it.each([
    [{ gatewayAddress: '10.5.50.1' }, 'gatewayAddress', /masque/],
    [{ gatewayAddress: '10.5.50.1/31' }, 'gatewayAddress', /\/16 à \/30/],
    [{ gatewayAddress: '10.5.50.1/15' }, 'gatewayAddress', /\/16 à \/30/],
    [
      { gatewayAddress: '100.64.0.1/24', poolStart: '100.64.0.10', poolEnd: '100.64.0.20' },
      'gatewayAddress',
      /privé/,
    ],
    [{ gatewayAddress: '10.5.50.0/24' }, 'gatewayAddress', /réseau/],
    [{ gatewayAddress: '10.5.50.255/24' }, 'gatewayAddress', /diffusion/],
    [{ poolStart: '10.5.51.10' }, 'poolStart', /Hors du réseau/],
    [{ poolEnd: '10.5.50.255' }, 'poolEnd', /Hors du réseau/],
    [{ poolStart: '10.5.50.0' }, 'poolStart', /Hors du réseau/],
    [{ poolStart: '10.5.50.200', poolEnd: '10.5.50.100' }, 'poolEnd', /suivre/],
    [{ poolStart: '10.5.50.1' }, 'poolStart', /en dehors de la plage/],
    [{ gatewayAddress: '10.5.50.100/24' }, 'poolStart', /en dehors de la plage/],
    [{ poolEnd: 'abc' }, 'poolEnd', /IPv4/],
  ])('refuse %j', (change, path, message) => {
    const issues = hotspotNetworkIssues({ ...valid, ...change });
    expect(issues.some((issue) => issue.path === path && message.test(issue.message))).toBe(true);
  });

  it('schéma de création : interface RouterOS et nom DNS', () => {
    const body = { routerId: UUID, name: 'Hotspot', interface: 'ether2', ...valid };
    expect(createHotspotRequestSchema.safeParse(body).success).toBe(true);
    expect(createHotspotRequestSchema.parse({ ...body, dnsName: 'WiFi.Example.NET' }).dnsName).toBe(
      'wifi.example.net',
    );
    expect(createHotspotRequestSchema.parse({ ...body, dnsName: '' }).dnsName).toBeNull();
    for (const bad of ['ether 2', 'eth;2', '', 'x'.repeat(41)]) {
      expect(createHotspotRequestSchema.safeParse({ ...body, interface: bad }).success, bad).toBe(
        false,
      );
    }
    expect(createHotspotRequestSchema.safeParse({ ...body, dnsName: 'localhost' }).success).toBe(
      false,
    );
    expect(createHotspotRequestSchema.safeParse({ ...body, poolStart: '10.5.50.1' }).success).toBe(
      false,
    );
  });

  it('schéma de modification : le réseau se modifie d’un bloc', () => {
    expect(updateHotspotRequestSchema.safeParse({ name: 'Nouveau' }).success).toBe(true);
    expect(updateHotspotRequestSchema.safeParse({ poolStart: '10.5.50.20' }).success).toBe(false);
    expect(updateHotspotRequestSchema.safeParse(valid).success).toBe(true);
    expect(updateHotspotRequestSchema.safeParse({}).success).toBe(false);
  });
});
