import { and, eq } from 'drizzle-orm';
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
  /** Modifiés pendant la rotation (activation, nouveaux identifiants) : non réécrits ici. */
  skipped: number;
}

/**
 * Ré-enveloppe les mots de passe RouterOS avec la clé active (rotation, `keys:rotate`) : seule
 * la clé de données change d'enveloppe. Ré-enveloppe contrôlée (S3H-H2) : chaque mot de passe
 * doit se déchiffrer avant ET après, à l'identique, sinon rien n'est écrit (SecretBox
 * .rewrapVerified). L'écriture est conditionnelle : un identifiant modifié entre-temps (il
 * est alors déjà sous la clé active) n'est pas écrasé. Rôle ecsi_worker (routeurs actifs) ou
 * propriétaire de la table (tous les routeurs, y compris supprimés).
 */
export async function rotateRouterSecrets(
  db: NodePgDatabase<Record<string, unknown>>,
  box: SecretBox,
  options: {
    dryRun?: boolean;
    onError?: (routerId: string, error: Error) => void;
    /** Point d'injection des tests : écriture concurrente entre la lecture et l'écriture. */
    beforeWrite?: (routerId: string) => Promise<void>;
  } = {},
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
  let skipped = 0;
  for (const row of rows) {
    // Routeur en cours d'enrôlement : pas encore de mot de passe.
    if (row.secret === null || !box.needsRewrap(row.secret)) continue;
    try {
      const next = box.rewrapVerified(
        row.secret,
        routerSecretAad({ companyId: row.companyId, routerId: row.id }),
      );
      if (!options.dryRun) {
        await options.beforeWrite?.(row.id);
        const updated = await db
          .update(routers)
          .set({ routerosPasswordEncrypted: next })
          .where(and(eq(routers.id, row.id), eq(routers.routerosPasswordEncrypted, row.secret)))
          .returning({ id: routers.id });
        if (updated.length === 0) {
          skipped += 1;
          continue;
        }
      }
      rewrapped += 1;
    } catch (error) {
      failed += 1;
      options.onError?.(row.id, error as Error);
    }
  }
  return { total: rows.length, rewrapped, failed, skipped };
}
