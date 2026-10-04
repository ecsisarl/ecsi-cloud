import { eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { SecretBox } from '../auth/crypto/secret-box.js';
import { routers } from '../database/schema/index.js';

/**
 * Mot de passe du compte de service RouterOS, chiffré par le SecretBox (AES-256-GCM,
 * enveloppe, ADR 0014). Les données associées lient le chiffré à l'entreprise ET au routeur :
 * copié sur un autre routeur (ou une autre entreprise), il ne se déchiffre pas.
 */
export interface RouterSecretOwner {
  readonly companyId: string;
  readonly routerId: string;
}

export function routerSecretAad(owner: RouterSecretOwner): string {
  return `router:${owner.companyId}:${owner.routerId}:routeros-password`;
}

export function encryptRouterPassword(
  box: SecretBox,
  owner: RouterSecretOwner,
  password: string,
): string {
  return box.encrypt(password, routerSecretAad(owner));
}

export function decryptRouterPassword(
  box: SecretBox,
  owner: RouterSecretOwner,
  payload: string,
): string {
  return box.decrypt(payload, routerSecretAad(owner));
}

export interface RouterRotationReport {
  total: number;
  rewrapped: number;
  failed: number;
}

/**
 * Ré-enveloppe les mots de passe RouterOS avec la clé active (rotation, `keys:rotate`). Le
 * mot de passe n'est jamais déchiffré : seule la clé de données change d'enveloppe.
 * Exécutée avec le rôle ecsi_worker (seul autorisé à réécrire cette colonne hors API).
 */
export async function rotateRouterSecrets(
  db: NodePgDatabase<Record<string, unknown>>,
  box: SecretBox,
  options: { dryRun?: boolean; onError?: (routerId: string, error: Error) => void } = {},
): Promise<RouterRotationReport> {
  const rows = await db
    .select({
      id: routers.id,
      companyId: routers.companyId,
      secret: routers.routerosPasswordEncrypted,
    })
    .from(routers);
  let rewrapped = 0;
  let failed = 0;
  for (const row of rows) {
    // Routeur en cours d'enrôlement : pas encore de mot de passe.
    if (row.secret === null || !box.needsRewrap(row.secret)) continue;
    try {
      const next = box.rewrap(
        row.secret,
        routerSecretAad({ companyId: row.companyId, routerId: row.id }),
      );
      if (!options.dryRun) {
        await db
          .update(routers)
          .set({ routerosPasswordEncrypted: next })
          .where(eq(routers.id, row.id));
      }
      rewrapped += 1;
    } catch (error) {
      failed += 1;
      options.onError?.(row.id, error as Error);
    }
  }
  return { total: rows.length, rewrapped, failed };
}
