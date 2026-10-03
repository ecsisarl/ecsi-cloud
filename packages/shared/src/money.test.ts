import { describe, expect, it } from 'vitest';
import { currencyDecimals, formatMoney, fromMinorUnits, toMinorUnits } from './money.js';

const normalizeSpaces = (s: string) => s.replace(/[\u202f\u00a0]/g, ' ');

describe('money', () => {
  it('XOF n’a pas de décimales', () => {
    expect(currencyDecimals('XOF')).toBe(0);
    expect(toMinorUnits(500, 'XOF')).toBe(500);
    expect(fromMinorUnits(2000, 'xof')).toBe(2000);
  });

  it('convertit les devises à deux décimales sans erreur d’arrondi', () => {
    expect(toMinorUnits(12.5, 'EUR')).toBe(1250);
    expect(toMinorUnits(0.29, 'USD')).toBe(29);
  });

  it('formate le FCFA à la française', () => {
    expect(normalizeSpaces(formatMoney(5000))).toBe('5 000 FCFA');
    expect(normalizeSpaces(formatMoney(100, 'XOF'))).toBe('100 FCFA');
  });

  it('refuse une devise inconnue et les montants invalides', () => {
    expect(() => currencyDecimals('ABC')).toThrow();
    expect(() => toMinorUnits(Number.NaN, 'XOF')).toThrow();
    expect(() => fromMinorUnits(1.5, 'XOF')).toThrow();
  });
});
