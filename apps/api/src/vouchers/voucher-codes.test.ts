import { VOUCHER_ALPHABETS } from '@ecsi/shared';
import { describe, expect, it } from 'vitest';
import { randomCode, uniqueCodes } from './voucher-codes.js';

describe('codes des tickets', () => {
  it('respecte préfixe, longueur et alphabet', () => {
    for (let i = 0; i < 200; i += 1) {
      const code = randomCode({ charset: 'UPPER_DIGITS', length: 6, prefix: 'WZ' });
      expect(code).toMatch(/^WZ[A-Z2-9]{6}$/);
      for (const c of code.slice(2)) expect(VOUCHER_ALPHABETS.UPPER_DIGITS).toContain(c);
    }
  });

  it('tire des codes distincts et évite les codes déjà pris', () => {
    const taken = new Set(['22222222']);
    const codes = uniqueCodes({ charset: 'DIGITS', length: 8, prefix: '' }, 1000, taken);
    expect(new Set(codes).size).toBe(1000);
    expect(codes).not.toContain('22222222');
  });

  it('échoue au lieu de boucler quand l’espace est saturé', () => {
    // 8 chiffres possibles sur 1 caractère : impossible d'en tirer 9 distincts.
    expect(() => uniqueCodes({ charset: 'DIGITS', length: 1, prefix: '' }, 9, new Set())).toThrow(
      /saturé/,
    );
  });
});
