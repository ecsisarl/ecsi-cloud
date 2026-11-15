import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Dérivations du lot B (Hotspot / FreeRADIUS). Trois clés DISTINCTES, chacune limitée à un
 * rôle, jamais en base ni dans Git (environnement du VPS, coffre d'escrow chiffré) :
 *
 *  - VOUCHER_CODE_KEY (API seule) : dérive le code imprimable d'un ticket à partir de son
 *    identifiant, ce qui permet la réimpression sans stocker le code ;
 *  - RADIUS_VOUCHER_LOOKUP_KEY (API et FreeRADIUS) : empreinte HMAC-SHA1 du code saisi, seule
 *    trace du code en base (vouchers.code_lookup) ;
 *  - RADIUS_NAS_KEY (worker et FreeRADIUS) : secret RADIUS propre à chaque routeur.
 *
 * Les clés sont des chaînes hexadécimales de 64 caractères (openssl rand -hex 32) utilisées
 * TELLES QUELLES comme clé HMAC (octets UTF-8 de la chaîne) : c'est ainsi que FreeRADIUS les
 * emploie (%{hmacsha1:&donnée &clé}), les deux côtés produisent donc la même empreinte.
 * FreeRADIUS 3.2 ne propose que hmacsha1 / hmacmd5 : HMAC-SHA1 reste une fonction
 * pseudo-aléatoire sûre (la faiblesse de collision de SHA-1 ne s'applique pas à HMAC).
 * Hors production, une valeur « devonly-… » est admise (piles de développement et de test,
 * sans secret littéral dans le dépôt) ; la production la refuse (marqueur devonly).
 */
export const RADIUS_KEY_PATTERN = /^(?:[0-9a-f]{64}|devonly-[a-z0-9-]{8,64})$/;

/** Alphabet des codes : minuscules et chiffres sans caractères ambigus (0/o, 1/l/i). */
export const VOUCHER_CODE_ALPHABET = '23456789abcdefghjkmnpqrstuvwxyz';
export const VOUCHER_CODE_LENGTH = 8;

export interface VersionedKey {
  readonly version: number;
  readonly key: string;
}

/** Trousseau : clé active (nouveaux tickets) et anciennes clés (réimpression). */
export interface VoucherCodeKeyring {
  readonly active: VersionedKey;
  readonly previous: readonly VersionedKey[];
}

/** « 1:hex,2:hex » -> liste de clés versionnées (VOUCHER_CODE_PREVIOUS_KEYS). */
export function parseVersionedKeys(value: string | undefined): VersionedKey[] {
  if (!value?.trim()) return [];
  return value.split(',').map((entry) => {
    const index = entry.indexOf(':');
    const version = Number(entry.slice(0, index).trim());
    const key = entry.slice(index + 1).trim();
    if (
      index <= 0 ||
      !Number.isInteger(version) ||
      version < 1 ||
      version > 999 ||
      !RADIUS_KEY_PATTERN.test(key)
    ) {
      throw new Error('format « version:hex64,… » attendu');
    }
    return { version, key };
  });
}

export function keyForVersion(ring: VoucherCodeKeyring, version: number): string {
  if (ring.active.version === version) return ring.active.key;
  const found = ring.previous.find((entry) => entry.version === version);
  if (!found) throw new Error(`Clé de code de ticket v${version} absente`);
  return found.key;
}

/**
 * Code imprimable d'un ticket, déterministe : HMAC-SHA256(clé, identifiant) converti dans
 * l'alphabet par tirage avec rejet (aucun biais). 31^8 ≈ 8,5·10¹¹ combinaisons.
 */
export function deriveVoucherCode(
  codeKey: string,
  voucherId: string,
  length = VOUCHER_CODE_LENGTH,
): string {
  const size = VOUCHER_CODE_ALPHABET.length;
  const limit = 256 - (256 % size);
  let code = '';
  for (let counter = 0; code.length < length; counter += 1) {
    const block = createHmac('sha256', codeKey)
      .update(`ecsi:voucher-code:${voucherId}:${counter}`)
      .digest();
    for (const byte of block) {
      if (byte < limit) code += VOUCHER_CODE_ALPHABET.charAt(byte % size);
      if (code.length === length) break;
    }
  }
  return code;
}

/** Normalisation du code saisi, identique à %{tolower:%{User-Name}} de FreeRADIUS. */
export function normalizeVoucherCode(code: string): string {
  return code.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
}

/** Empreinte stockée dans vouchers.code_lookup (HMAC-SHA1 hexadécimal du code normalisé). */
export function voucherLookup(lookupKey: string, code: string): string {
  return createHmac('sha1', lookupKey).update(normalizeVoucherCode(code)).digest('hex');
}

/** Comparaison en temps constant de deux empreintes hexadécimales. */
export function lookupsEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Secret RADIUS du routeur : HMAC-SHA1(RADIUS_NAS_KEY, "nas:<router>:<version>"), 40
 * caractères hexadécimaux. FreeRADIUS calcule la même valeur à partir de
 * radius.nas_identity() ; augmenter hotspots.nas_secret_version change le secret.
 */
export function nasSecret(nasKey: string, routerId: string, version: number): string {
  return createHmac('sha1', nasKey).update(`nas:${routerId}:${version}`).digest('hex');
}
