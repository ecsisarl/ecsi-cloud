import { hash, verify } from '@node-rs/argon2';

/**
 * Hachage des mots de passe : Argon2id, paramètres OWASP 2024 (m = 19 Mio, t = 2, p = 1).
 * Les paramètres sont inscrits dans chaque empreinte : ils pourront être relevés sans
 * invalider les mots de passe existants.
 */
const OPTIONS = {
  // Algorithm.Argon2id (enum « const » non importable avec isolatedModules).
  algorithm: 2,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

export function hashPassword(password: string): Promise<string> {
  return hash(password, OPTIONS);
}

export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
}

let dummyHash: Promise<string> | undefined;

/**
 * Vérification factice pour un compte inexistant : le temps de réponse est le même que
 * pour un compte existant, ce qui empêche l'énumération des adresses par chronométrage.
 */
export async function verifyAgainstDummy(password: string): Promise<false> {
  dummyHash ??= hash('ecsi-dummy-password-for-timing', OPTIONS);
  await verifyPassword(await dummyHash, password);
  return false;
}
