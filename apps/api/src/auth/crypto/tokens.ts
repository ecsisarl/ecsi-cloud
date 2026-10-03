import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

/** Jeton opaque de 256 bits, encodé en base64url (43 caractères). Jamais stocké en clair. */
export function generateOpaqueToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Empreinte stockée en base pour un jeton opaque (recherche par égalité, index unique). */
export function hashToken(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest();
}

export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

// Alphabet sans caractères ambigus (0/O, 1/I/L) pour les codes saisis à la main.
const RECOVERY_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/** Codes de récupération 2FA au format XXXXX-XXXXX (≈ 49 bits d'entropie chacun). */
export function generateRecoveryCodes(count = 10): string[] {
  return Array.from({ length: count }, () => {
    const chars = Array.from(
      { length: 10 },
      () => RECOVERY_ALPHABET[randomInt(RECOVERY_ALPHABET.length)] ?? 'A',
    ).join('');
    return `${chars.slice(0, 5)}-${chars.slice(5)}`;
  });
}

/** Forme normalisée d'un code de récupération avant hachage ou comparaison. */
export function normalizeRecoveryCode(code: string): string {
  return code.replace(/-/g, '').toUpperCase();
}
