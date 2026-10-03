import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ROLE_PERMISSIONS,
  PERMISSIONS,
  PERMISSION_CODES,
  isPermission,
} from './permissions.js';
import { COMPANY_SYSTEM_ROLES, isCompanySystemRole } from './roles.js';

describe('catalogue des permissions', () => {
  it('a des codes uniques au format ressource.action', () => {
    expect(new Set(PERMISSION_CODES).size).toBe(PERMISSION_CODES.length);
    for (const permission of PERMISSIONS) {
      expect(permission.code).toMatch(/^[a-z_]+(\.[a-z_]+)+$/);
      expect(permission.code.startsWith(`${permission.module}.`)).toBe(true);
    }
  });

  it('définit une matrice pour chaque rôle système d’entreprise, avec des codes connus', () => {
    expect(Object.keys(DEFAULT_ROLE_PERMISSIONS).sort()).toEqual([...COMPANY_SYSTEM_ROLES].sort());
    for (const codes of Object.values(DEFAULT_ROLE_PERMISSIONS)) {
      expect(codes.length).toBeGreaterThan(0);
      for (const code of codes) expect(isPermission(code)).toBe(true);
      expect(new Set(codes).size).toBe(codes.length);
    }
  });

  it('réserve les actions dangereuses aux rôles d’encadrement', () => {
    const dangerous = PERMISSIONS.filter((p) => 'dangerous' in p && p.dangerous).map((p) => p.code);
    for (const role of ['VENDEUR', 'SUPPORT', 'COMPTABLE'] as const) {
      const granted: readonly string[] = DEFAULT_ROLE_PERMISSIONS[role];
      expect(granted.filter((code) => dangerous.includes(code as never))).toEqual([]);
    }
  });

  it('ne crée jamais SUPER_ADMIN dans une entreprise', () => {
    expect(isCompanySystemRole('SUPER_ADMIN')).toBe(false);
    expect(isCompanySystemRole('ADMIN_ENTREPRISE')).toBe(true);
  });
});
