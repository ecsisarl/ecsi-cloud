import { randomInt } from 'node:crypto';
import { VOUCHER_ALPHABETS, type VoucherCharset } from '@ecsi/shared';

export interface CodeFormat {
  readonly charset: VoucherCharset;
  readonly length: number;
  readonly prefix: string;
}

/** Code aléatoire (générateur cryptographique, tirage uniforme sans biais de modulo). */
export function randomCode(format: CodeFormat): string {
  const alphabet = VOUCHER_ALPHABETS[format.charset];
  let code = format.prefix;
  for (let i = 0; i < format.length; i += 1) code += alphabet.charAt(randomInt(alphabet.length));
  return code;
}

/**
 * Tire `count` codes distincts entre eux et absents de `taken` (codes déjà utilisés dans
 * l'entreprise). Échoue si l'espace de codes est presque épuisé plutôt que de boucler.
 */
export function uniqueCodes(format: CodeFormat, count: number, taken: ReadonlySet<string>) {
  const result = new Set<string>();
  const maxAttempts = count * 20 + 100;
  let attempts = 0;
  while (result.size < count) {
    attempts += 1;
    if (attempts > maxAttempts) {
      throw new Error('Espace de codes saturé : allongez le code ou changez de préfixe');
    }
    const code = randomCode(format);
    if (!taken.has(code)) result.add(code);
  }
  return [...result];
}
