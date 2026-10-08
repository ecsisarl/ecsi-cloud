import { describe, expect, it } from 'vitest';
import { createCipheriv, createHmac, hkdfSync, randomBytes } from 'node:crypto';
import { hashPassword, verifyAgainstDummy, verifyPassword } from './password.js';
import { parseKeyList, SecretBox } from './secret-box.js';
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

describe('SecretBox (enveloppe AES-256-GCM, clés versionnées)', () => {
  const k1 = Buffer.alloc(32, 1).toString('base64');
  const k2 = Buffer.alloc(32, 2).toString('base64');
  const box = new SecretBox(k1);

  /** Chiffré au format v1 du Sprint 1 (clé dérivée directement, sans enveloppe). */
  function legacyV1(masterBase64: string, plaintext: string, aad: string): string {
    const key = Buffer.from(
      hkdfSync('sha256', Buffer.from(masterBase64, 'base64'), '', 'ecsi:aes-gcm:v1', 32),
    );
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(aad, 'utf8'));
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return ['v1', iv, cipher.getAuthTag(), ct]
      .map((p) => (typeof p === 'string' ? p : p.toString('base64url')))
      .join(':');
  }

  it('chiffre de façon non déterministe (v2, identifiant de clé) et déchiffre', () => {
    const a = box.encrypt('JBSWY3DPEHPK3PXP', 'user:1');
    expect(a).toMatch(/^v2:k1:/);
    expect(a.split(':')).toHaveLength(8);
    expect(a).not.toContain('JBSWY3DPEHPK3PXP');
    expect(box.encrypt('JBSWY3DPEHPK3PXP', 'user:1')).not.toBe(a);
    expect(box.decrypt(a, 'user:1')).toBe('JBSWY3DPEHPK3PXP');
  });

  it('refuse un chiffré altéré ou associé à un autre propriétaire', () => {
    const payload = box.encrypt('secret', 'user:1');
    expect(() => box.decrypt(payload, 'user:2')).toThrow();
    for (const index of [4, 7]) {
      const parts = payload.split(':');
      parts[index] = Buffer.from('autre-valeur-quelconque').toString('base64url');
      expect(() => box.decrypt(parts.join(':'), 'user:1')).toThrow();
    }
    // Changer l'identifiant de clé ne permet pas de contourner l'authentification.
    const swapped = payload.replace(/^v2:k1:/, 'v2:k0:');
    expect(() => box.decrypt(swapped, 'user:1')).toThrow();
  });

  it('refuse une clé de mauvaise taille, un identifiant invalide et produit des empreintes stables', () => {
    expect(() => new SecretBox(Buffer.alloc(16).toString('base64'))).toThrow();
    expect(() => new SecretBox(k1, { id: 'Pas Valide' })).toThrow();
    expect(() => new SecretBox(k1, { id: 'k1', previous: [{ id: 'k1', base64: k2 }] })).toThrow();
    expect(box.fingerprint('a@b.ci')).toBe(box.fingerprint('a@b.ci'));
    expect(box.fingerprint('a@b.ci')).not.toContain('a@b');
  });

  it('lit encore le format v1 du Sprint 1, avec la clé active ou une ancienne clé', () => {
    const v1 = legacyV1(k1, 'GRAINE', 'mfa:user:1');
    expect(box.decrypt(v1, 'mfa:user:1')).toBe('GRAINE');
    const rotated = new SecretBox(k2, { id: 'k2', previous: [{ id: 'k1', base64: k1 }] });
    expect(rotated.decrypt(v1, 'mfa:user:1')).toBe('GRAINE');
    expect(() => rotated.decrypt(v1, 'mfa:user:2')).toThrow();
  });

  it('rotation : ré-enveloppe la clé de données sans changer le chiffré du secret', () => {
    const old = box.encrypt('GRAINE', 'mfa:user:1');
    const rotated = new SecretBox(k2, { id: 'k2', previous: [{ id: 'k1', base64: k1 }] });
    expect(rotated.decrypt(old, 'mfa:user:1')).toBe('GRAINE');
    expect(rotated.needsRewrap(old)).toBe(true);
    const rewrapped = rotated.rewrap(old, 'mfa:user:1');
    expect(rewrapped).toMatch(/^v2:k2:/);
    expect(rotated.needsRewrap(rewrapped)).toBe(false);
    // Seule l'enveloppe change : IV, tag et chiffré du secret sont identiques.
    expect(rewrapped.split(':').slice(5)).toEqual(old.split(':').slice(5));
    // L'ancienne clé peut être retirée une fois la rotation faite.
    const k2Only = new SecretBox(k2, { id: 'k2' });
    expect(k2Only.decrypt(rewrapped, 'mfa:user:1')).toBe('GRAINE');
    expect(() => k2Only.decrypt(old, 'mfa:user:1')).toThrow(/indisponible/);
    // Le v1 est converti en v2.
    const fromV1 = rotated.rewrap(legacyV1(k1, 'GRAINE', 'a'), 'a');
    expect(fromV1).toMatch(/^v2:k2:/);
    expect(k2Only.decrypt(fromV1, 'a')).toBe('GRAINE');
  });

  it('ré-enveloppe contrôlée (S3H-H2) : relit le secret avant et après, refuse un chiffré altéré', () => {
    const old = box.encrypt('MOT-DE-PASSE', 'router:a:b:routeros-password');
    const rotated = new SecretBox(k2, { id: 'k2', previous: [{ id: 'k1', base64: k1 }] });
    const next = rotated.rewrapVerified(old, 'router:a:b:routeros-password');
    expect(next).toMatch(/^v2:k2:/);
    expect(new SecretBox(k2, { id: 'k2' }).decrypt(next, 'router:a:b:routeros-password')).toBe(
      'MOT-DE-PASSE',
    );
    // Chiffré du secret altéré, enveloppe intacte : rewrap seul ne le verrait pas.
    const parts = old.split(':');
    parts[7] = Buffer.from('autre-contenu').toString('base64url');
    const corrupted = parts.join(':');
    expect(() => rotated.rewrap(corrupted, 'router:a:b:routeros-password')).not.toThrow();
    expect(() => rotated.rewrapVerified(corrupted, 'router:a:b:routeros-password')).toThrow();
    // Mauvais propriétaire (données associées) ou ancienne clé absente : refus.
    expect(() => rotated.rewrapVerified(old, 'router:a:c:routeros-password')).toThrow();
    expect(() =>
      new SecretBox(k2, { id: 'k2' }).rewrapVerified(old, 'router:a:b:routeros-password'),
    ).toThrow(/indisponible/);
  });

  it('empreintes HMAC versionnées : retrouvées après rotation, y compris le format du Sprint 1', () => {
    const legacyMac = createHmac(
      'sha256',
      Buffer.from(hkdfSync('sha256', Buffer.from(k1, 'base64'), '', 'ecsi:hmac:v1', 32)),
    )
      .update('CODE', 'utf8')
      .digest('base64url');
    expect(box.mac('CODE')).toBe(`k1$${legacyMac}`);
    const rotated = new SecretBox(k2, { id: 'k2', previous: [{ id: 'k1', base64: k1 }] });
    expect(rotated.mac('CODE')).toMatch(/^k2\$/);
    const candidates = rotated.macCandidates('CODE');
    expect(candidates).toContain(box.mac('CODE'));
    expect(candidates).toContain(legacyMac);
    expect(candidates).toContain(rotated.mac('CODE'));
  });

  it('analyse la liste des anciennes clés', () => {
    expect(parseKeyList(undefined)).toEqual([]);
    expect(parseKeyList(`k1:${k1},k0:${k2}`)).toEqual([
      { id: 'k1', base64: k1 },
      { id: 'k0', base64: k2 },
    ]);
    expect(() => parseKeyList('sans-separateur')).toThrow();
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
