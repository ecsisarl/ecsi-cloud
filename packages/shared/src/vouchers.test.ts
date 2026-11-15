import { describe, expect, it } from 'vitest';
import {
  createPlanRequestSchema,
  formatBytes,
  formatDuration,
  formatRate,
  generateVoucherBatchRequestSchema,
  maskVoucherCode,
  minVoucherLength,
  updatePlanRequestSchema,
  VOUCHER_ALPHABETS,
} from './vouchers.js';

const base = {
  planId: '0190a0b0-0000-7000-8000-000000000001',
  siteId: '0190a0b0-0000-7000-8000-000000000002',
  quantity: 10,
};

describe('alphabets des tickets', () => {
  it('ne contiennent aucun caractère ambigu', () => {
    for (const alphabet of Object.values(VOUCHER_ALPHABETS)) {
      expect(alphabet).not.toMatch(/[01OIl]/);
      expect(new Set(alphabet).size).toBe(alphabet.length);
    }
  });

  it('imposent au moins 24 bits d’entropie', () => {
    expect(minVoucherLength('DIGITS')).toBe(8);
    expect(minVoucherLength('UPPER_DIGITS')).toBe(5);
    expect(minVoucherLength('MIXED')).toBe(5);
  });
});

describe('generateVoucherBatchRequestSchema', () => {
  it('applique les valeurs par défaut de Mikhmon (code chiffré de 8)', () => {
    const parsed = generateVoucherBatchRequestSchema.parse(base);
    expect(parsed).toMatchObject({ authMode: 'CODE', charset: 'DIGITS', length: 8, prefix: '' });
    expect(parsed.expiresAt).toBeNull();
  });

  it('refuse un code trop court pour son alphabet', () => {
    expect(generateVoucherBatchRequestSchema.safeParse({ ...base, length: 6 }).success).toBe(false);
    expect(
      generateVoucherBatchRequestSchema.safeParse({ ...base, charset: 'UPPER_DIGITS', length: 6 })
        .success,
    ).toBe(true);
  });

  it('borne la quantité à 1 000 et refuse un préfixe ambigu', () => {
    expect(generateVoucherBatchRequestSchema.safeParse({ ...base, quantity: 1001 }).success).toBe(
      false,
    );
    expect(generateVoucherBatchRequestSchema.safeParse({ ...base, prefix: 'W0' }).success).toBe(
      false,
    );
    expect(generateVoucherBatchRequestSchema.safeParse({ ...base, prefix: 'WZ' }).success).toBe(
      true,
    );
  });
});

describe('forfaits', () => {
  it('valeurs par défaut : XOF, 1 appareil, illimité', () => {
    const plan = createPlanRequestSchema.parse({ name: '1 heure', priceAmount: 200 });
    expect(plan).toMatchObject({
      currency: 'XOF',
      maxDevices: 1,
      sessionTimeSeconds: null,
      status: 'ACTIVE',
    });
  });

  it('la modification partielle ne remet aucune valeur par défaut', () => {
    expect(updatePlanRequestSchema.parse({ priceAmount: 300 })).toEqual({ priceAmount: 300 });
  });

  it('refuse un prix décimal ou une devise inconnue', () => {
    expect(createPlanRequestSchema.safeParse({ name: 'x1', priceAmount: 2.5 }).success).toBe(false);
    expect(
      createPlanRequestSchema.safeParse({ name: 'x1', priceAmount: 2, currency: 'ABC' }).success,
    ).toBe(false);
  });
});

describe('formats', () => {
  it('masque un code en gardant le préfixe', () => {
    expect(maskVoucherCode('48291761')).toBe('48••••61');
    expect(maskVoucherCode('WZ48291761', 2)).toBe('WZ48••••61');
    expect(maskVoucherCode('ABCD')).toBe('••••');
  });

  it('durées, volumes et débits', () => {
    expect(formatDuration(3600)).toBe('1 h');
    expect(formatDuration(90_000)).toBe('1 j 1 h');
    expect(formatDuration(null)).toBe('Illimité');
    expect(formatBytes(1024 ** 3)).toBe('1 Go');
    expect(formatRate(2000)).toBe('2 Mbit/s');
    expect(formatRate(512)).toBe('512 kbit/s');
  });
});
