import { describe, expect, it } from 'vitest';
import { hashPassword, verifyAgainstDummy, verifyPassword } from './password.js';
import { SecretBox } from './secret-box.js';
import {
  generateOpaqueToken,
  generateRecoveryCodes,
  hashToken,
  normalizeRecoveryCode,
} from './tokens.js';
import {
  base32Decode,
  base32Encode,
  generateTotpSecret,
  hotp,
  otpauthUri,
  timeStep,
  totp,
  verifyTotp,
} from './totp.js';

describe('Argon2id', () => {
  it('produit une empreinte argon2id aux paramètres OWASP et la vérifie', async () => {
    const digest = await hashPassword('une phrase de passe');
    expect(digest).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(await verifyPassword(digest, 'une phrase de passe')).toBe(true);
    expect(await verifyPassword(digest, 'mauvais')).toBe(false);
    expect(await verifyPassword('pas-une-empreinte', 'x')).toBe(false);
    expect(await verifyAgainstDummy('x')).toBe(false);
  });
});

describe('jetons opaques', () => {
  it('sont aléatoires, en base64url de 43 caractères, et hachés en SHA-256', () => {
    const token = generateOpaqueToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(generateOpaqueToken()).not.toBe(token);
    expect(hashToken(token)).toHaveLength(32);
    expect(hashToken(token).equals(hashToken(token))).toBe(true);
  });

  it('génère 10 codes de récupération uniques', () => {
    const codes = generateRecoveryCodes();
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const code of codes) expect(code).toMatch(/^[A-Z2-9]{5}-[A-Z2-9]{5}$/);
    expect(normalizeRecoveryCode('abcde-fghjk')).toBe('ABCDEFGHJK');
  });
});

describe('SecretBox (AES-256-GCM)', () => {
  const box = new SecretBox(Buffer.alloc(32, 1).toString('base64'));

  it('chiffre de façon non déterministe et déchiffre', () => {
    const a = box.encrypt('JBSWY3DPEHPK3PXP', 'user:1');
    expect(a).toMatch(/^v1:/);
    expect(a).not.toContain('JBSWY3DPEHPK3PXP');
    expect(box.encrypt('JBSWY3DPEHPK3PXP', 'user:1')).not.toBe(a);
    expect(box.decrypt(a, 'user:1')).toBe('JBSWY3DPEHPK3PXP');
  });

  it('refuse un chiffré altéré ou associé à un autre propriétaire', () => {
    const payload = box.encrypt('secret', 'user:1');
    expect(() => box.decrypt(payload, 'user:2')).toThrow();
    const parts = payload.split(':');
    parts[3] = Buffer.from('autre').toString('base64url');
    expect(() => box.decrypt(parts.join(':'), 'user:1')).toThrow();
  });

  it('refuse une clé de mauvaise taille et produit des empreintes stables', () => {
    expect(() => new SecretBox(Buffer.alloc(16).toString('base64'))).toThrow();
    expect(box.fingerprint('a@b.ci')).toBe(box.fingerprint('a@b.ci'));
    expect(box.fingerprint('a@b.ci')).not.toContain('a@b');
  });
});

describe('TOTP (RFC 6238)', () => {
  // Vecteurs de test officiels de la RFC 6238, annexe B (SHA-1, 8 chiffres).
  const rfcKey = Buffer.from('12345678901234567890', 'ascii');
  const vectors: [number, string][] = [
    [59, '94287082'],
    [1111111109, '07081804'],
    [1111111111, '14050471'],
    [1234567890, '89005924'],
    [2000000000, '69279037'],
    [20000000000, '65353130'],
  ];

  it.each(vectors)('respecte le vecteur RFC 6238 à T=%i', (seconds, expected) => {
    expect(hotp(rfcKey, timeStep(seconds * 1000), 8)).toBe(expected);
  });

  it('respecte les vecteurs HOTP de la RFC 4226', () => {
    expect([0, 1, 2, 3, 9].map((counter) => hotp(rfcKey, counter))).toEqual([
      '755224',
      '287082',
      '359152',
      '969429',
      '520489',
    ]);
  });

  it('encode et décode le base32', () => {
    expect(base32Encode(rfcKey)).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    expect(base32Decode('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ').equals(rfcKey)).toBe(true);
    expect(generateTotpSecret()).toMatch(/^[A-Z2-7]{32}$/);
  });

  it('accepte ±1 pas, refuse au-delà et refuse le rejeu', () => {
    const secret = generateTotpSecret();
    const now = 1_800_000_000_000;
    const step = timeStep(now);
    expect(verifyTotp(secret, totp(secret, now), now, null)).toBe(step);
    expect(verifyTotp(secret, totp(secret, now - 30_000), now, null)).toBe(step - 1);
    expect(verifyTotp(secret, totp(secret, now + 30_000), now, null)).toBe(step + 1);
    expect(verifyTotp(secret, totp(secret, now - 90_000), now, null)).toBeNull();
    expect(verifyTotp(secret, totp(secret, now), now, step)).toBeNull();
    expect(verifyTotp(secret, 'abcdef', now, null)).toBeNull();
  });

  it('construit une URI otpauth standard', () => {
    const uri = otpauthUri('JBSWY3DPEHPK3PXP', 'awa@exemple.ci');
    expect(uri).toBe(
      'otpauth://totp/ECSI%20CLOUD:awa%40exemple.ci?secret=JBSWY3DPEHPK3PXP&issuer=ECSI+CLOUD&algorithm=SHA1&digits=6&period=30',
    );
  });
});
