import { describe, expect, it } from 'vitest';
import {
  ALERT_SEVERITY,
  ALERT_TYPES,
  listAlertsQuerySchema,
  memoryUsedPercent,
  routerMetricsQuerySchema,
} from './monitoring.js';
import { DEFAULT_ROLE_PERMISSIONS } from './permissions.js';

describe('supervision et alertes (lot E1)', () => {
  it('une gravité par type, OFFLINE critique', () => {
    expect(Object.keys(ALERT_SEVERITY).sort()).toEqual([...ALERT_TYPES].sort());
    expect(ALERT_SEVERITY.ROUTER_OFFLINE).toBe('CRITICAL');
  });

  it('pourcentage de mémoire utilisée, null si la mesure est absente ou incohérente', () => {
    expect(memoryUsedPercent(1000, 250)).toBe(75);
    expect(memoryUsedPercent(1073741824, 900000000)).toBe(16);
    expect(memoryUsedPercent(null, 10)).toBeNull();
    expect(memoryUsedPercent(0, 0)).toBeNull();
    expect(memoryUsedPercent(100, 200)).toBeNull();
  });

  it('requêtes validées strictement (aucun identifiant d’entreprise accepté)', () => {
    expect(listAlertsQuerySchema.parse({})).toEqual({ state: 'open', limit: 50 });
    expect(() => listAlertsQuerySchema.parse({ companyId: 'x' })).toThrow();
    expect(() => listAlertsQuerySchema.parse({ limit: '500' })).toThrow();
    expect(routerMetricsQuerySchema.parse({ hours: '6' })).toEqual({ hours: 6 });
    expect(() => routerMetricsQuerySchema.parse({ hours: '0' })).toThrow();
  });

  it('acquittement : techniciens et support, pas les vendeurs ni les comptables', () => {
    for (const role of ['ADMIN_ENTREPRISE', 'GERANT', 'TECHNICIEN', 'SUPPORT'] as const) {
      expect(DEFAULT_ROLE_PERMISSIONS[role]).toContain('monitoring.acknowledge');
    }
    for (const role of ['VENDEUR', 'COMPTABLE'] as const) {
      expect(DEFAULT_ROLE_PERMISSIONS[role]).not.toContain('monitoring.acknowledge');
    }
  });
});
