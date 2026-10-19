import { createHmac, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  deriveVoucherCode,
  keyForVersion,
  lookupsEqual,
  nasSecret,
  normalizeVoucherCode,
  parseVersionedKeys,
  VOUCHER_CODE_ALPHABET,
  voucherLookup,
} from './radius-keys.js';

const key = () => randomBytes(32).toString('hex');

describe('codes de ticket', () => {
  it('dérive un code stable, dans l’alphabet, différent selon la clé et le ticket', () => {
    const k = key();
    const id = '0192a3b4-c5d6-7e8f-9a0b-1c2d3e4f5a6b';
    const code = deriveVoucherCode(k, id);
    expect(code).toHaveLength(8);
    expect(code).toMatch(new RegExp(`^[${VOUCHER_CODE_ALPHABET}]+$`));
    expect(deriveVoucherCode(k, id)).toBe(code);
    expect(deriveVoucherCode(key(), id)).not.toBe(code);
    expect(deriveVoucherCode(k, id.replace(/b$/, 'c'))).not.toBe(code);
    expect(deriveVoucherCode(k, id, 12)).toHaveLength(12);
  });

  it('répartit les caractères sans biais grossier', () => {
    const k = key();
    const counts = new Map<string, number>();
    for (let i = 0; i < 4000; i += 1) {
      for (const c of deriveVoucherCode(k, `id-${i}`)) counts.set(c, (counts.get(c) ?? 0) + 1);
    }
    expect(counts.size).toBe(VOUCHER_CODE_ALPHABET.length);
    const expected = (4000 * 8) / VOUCHER_CODE_ALPHABET.length;
    for (const n of counts.values()) expect(Math.abs(n - expected) / expected).toBeLessThan(0.15);
  });

  it('empreinte : HMAC-SHA1 du code en minuscules, avec la clé prise comme texte', () => {
    const k = key();
    expect(voucherLookup(k, 'AbC234xy')).toBe(
      createHmac('sha1', Buffer.from(k, 'utf8')).update('abc234xy').digest('hex'),
    );
    expect(voucherLookup(k, 'ABC234XY')).toBe(voucherLookup(k, 'abc234xy'));
    expect(voucherLookup(key(), 'abc234xy')).not.toBe(voucherLookup(k, 'abc234xy'));
    expect(normalizeVoucherCode('É-Ab')).toBe('É-ab');
  });

  it('valeur de référence partagée avec FreeRADIUS (test d’intégration radius)', () => {
    // Même calcul que %{hmacsha1:&Tmp-String-3 &Tmp-String-4}, vérifié avec radclient.
    expect(voucherLookup('devonly-voucher-key', 'AbC12345')).toBe(
      '11cfff262b435dfafdcc59177054978c02410e69',
    );
    expect(nasSecret('devonly-nas-key', '127.0.0.1', 1)).toBe(
      createHmac('sha1', 'devonly-nas-key').update('nas:127.0.0.1:1').digest('hex'),
    );
  });

  it('compare les empreintes en temps constant, sans erreur sur longueur différente', () => {
    expect(lookupsEqual('ab', 'ab')).toBe(true);
    expect(lookupsEqual('ab', 'ac')).toBe(false);
    expect(lookupsEqual('ab', 'abc')).toBe(false);
  });

  it('trousseau versionné', () => {
    const [a, b] = [key(), key()];
    const previous = parseVersionedKeys(`1:${a}, 2:${b}`);
    expect(previous).toEqual([
      { version: 1, key: a },
      { version: 2, key: b },
    ]);
    const ring = { active: { version: 3, key: key() }, previous };
    expect(keyForVersion(ring, 2)).toBe(b);
    expect(keyForVersion(ring, 3)).toBe(ring.active.key);
    expect(() => keyForVersion(ring, 4)).toThrow(/v4/);
    expect(() => parseVersionedKeys('x:abc')).toThrow();
    expect(() => parseVersionedKeys(`0:${a}`)).toThrow();
  });
});
