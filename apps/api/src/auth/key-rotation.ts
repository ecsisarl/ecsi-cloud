import { eq, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { mfaFactors, mfaRecoveryCodes } from '../database/schema/index.js';
import type { SecretBox } from './crypto/secret-box.js';

export interface RotationReport {
  total: number;
  rewrapped: number;
  failed: number;
  /** Codes de récupération non utilisés, par identifiant de clé (« v1 » : format Sprint 1). */
  recoveryCodesByKey: { key: string; count: number }[];
}

/**
 * Ré-enveloppe chaque secret 2FA avec la clé active (ADR 0014). Idempotente. Utilisée par
 * la commande `pnpm keys:rotate` (rôle ecsi_auth) et par les tests d'intégration.
 */
export async function rotateEncryptionKeys(
  db: NodePgDatabase<Record<string, unknown>>,
  box: SecretBox,
  options: { dryRun?: boolean; onError?: (factorId: string, error: Error) => void } = {},
): Promise<RotationReport> {
  const factors = await db
    .select({
      id: mfaFactors.id,
      userId: mfaFactors.userId,
      platformAdminId: mfaFactors.platformAdminId,
      secretEnc: mfaFactors.secretEnc,
    })
    .from(mfaFactors);

  let rewrapped = 0;
  let failed = 0;
  for (const factor of factors) {
    if (!box.needsRewrap(factor.secretEnc)) continue;
    // Mêmes données associées que MfaService : le chiffré reste lié à son propriétaire.
    const aad = factor.userId
      ? `mfa:user:${factor.userId}`
      : `mfa:platform:${factor.platformAdminId ?? ''}`;
    try {
      const next = box.rewrap(factor.secretEnc, aad);
      if (!options.dryRun) {
        await db.update(mfaFactors).set({ secretEnc: next }).where(eq(mfaFactors.id, factor.id));
      }
      rewrapped += 1;
    } catch (error) {
      failed += 1;
      // Jamais la valeur chiffrée ni la clé : uniquement l'identifiant de ligne.
      options.onError?.(factor.id, error as Error);
    }
  }

  const byKey = await db
    .select({
      key: sql<string>`case when position('$' in ${mfaRecoveryCodes.codeHash}) > 0
        then split_part(${mfaRecoveryCodes.codeHash}, '$', 1) else 'v1 (Sprint 1)' end`,
      count: sql<number>`count(*)::int`,
    })
    .from(mfaRecoveryCodes)
    .where(sql`${mfaRecoveryCodes.usedAt} is null`)
    .groupBy(sql`1`);

  return {
    total: factors.length,
    rewrapped,
    failed,
    recoveryCodesByKey: byKey.map((row) => ({
      key: row.key === 'v1 (Sprint 1)' ? 'v1' : row.key,
      count: row.count,
    })),
  };
}
