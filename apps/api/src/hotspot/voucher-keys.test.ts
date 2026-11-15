import { randomBytes } from 'node:crypto';
import { ServiceUnavailableException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { deriveVoucherCode, voucherLookup } from './radius-keys.js';
import { VOUCHER_KEYS_MISSING, VOUCHER_KEY_VERSION_MISSING, VoucherKeys } from './voucher-keys.js';

// Clés de test tirées à l'exécution (jamais écrites dans le dépôt).
const hex = () => randomBytes(32).toString('hex');
const codeKey = hex();
const previousKey = hex();
const lookupKey = hex();
const ID = '0190a6b0-0000-7000-8000-000000000001';

const configured = () =>
  new VoucherKeys({
    VOUCHER_CODE_KEY: codeKey,
    VOUCHER_CODE_KEY_VERSION: 2,
    VOUCHER_CODE_PREVIOUS_KEYS: `1:${previousKey}`,
    RADIUS_VOUCHER_LOOKUP_KEY: lookupKey,
    RADIUS_VOUCHER_LOOKUP_KEY_VERSION: 3,
  });

describe('VoucherKeys', () => {
  it('sans clés : 503 « clés de tickets non configurées », sans autre détail', () => {
    const keys = new VoucherKeys({
      VOUCHER_CODE_KEY_VERSION: 1,
      RADIUS_VOUCHER_LOOKUP_KEY_VERSION: 1,
    });
    expect(keys.configured).toBe(false);
    expect(() => keys.issue(ID)).toThrow(ServiceUnavailableException);
    expect(() => keys.issue(ID)).toThrow(VOUCHER_KEYS_MISSING);
    expect(() => keys.codeOf(ID, 1)).toThrow(VOUCHER_KEYS_MISSING);
  });

  it('nouveau ticket : code de la clé active, empreinte de la clé d’empreinte', () => {
    const keys = configured();
    expect(keys.versions()).toEqual({ codeKeyVersion: 2, lookupKeyVersion: 3 });
    const { code, lookup } = keys.issue(ID);
    expect(code).toBe(deriveVoucherCode(codeKey, ID));
    expect(lookup).toBe(voucherLookup(lookupKey, code));
    expect(lookup).toMatch(/^[0-9a-f]{40}$/);
  });

  it('réimpression : clé de la version du ticket, ancienne clé comprise', () => {
    const keys = configured();
    expect(keys.codeOf(ID, 2)).toBe(deriveVoucherCode(codeKey, ID));
    expect(keys.codeOf(ID, 1)).toBe(deriveVoucherCode(previousKey, ID));
    expect(keys.codeOf(ID, 1)).not.toBe(keys.codeOf(ID, 2));
  });

  it('version absente du trousseau : 503 sans clé ni code dans le message', () => {
    const keys = configured();
    let message = '';
    try {
      keys.codeOf(ID, 9);
    } catch (error) {
      expect(error).toBeInstanceOf(ServiceUnavailableException);
      message = (error as Error).message;
    }
    expect(message).toBe(VOUCHER_KEY_VERSION_MISSING);
    expect(message).not.toContain(codeKey);
  });
});
