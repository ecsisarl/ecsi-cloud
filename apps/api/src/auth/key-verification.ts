/**
 * Vérification de la clé de chiffrement (Sprint S3H, étape H2), en LECTURE SEULE.
 *
 * Pour chaque mot de passe RouterOS (tous les routeurs, y compris supprimés et en cours
 * d'enrôlement) et chaque secret 2FA :
 *  - sous la clé active : déchiffrement avec la SEULE clé active, sans recours aux anciennes ;
 *  - sous une ancienne clé : déchiffrement avec cette clé (« encore à ré-envelopper ») ;
 *  - illisible : aucune clé fournie ne le déchiffre (clé absente, données altérées).
 * Les codes de récupération 2FA non utilisés (empreintes HMAC, non ré-envelopables) sont
 * comptés par clé. Une ancienne clé n'est déclarée retirable qu'avec : tout sous la clé
 * active, 0 illisible et aucun code de récupération encore lié à une ancienne clé.
 *
 * Connexion : propriétaire des tables (DATABASE_MIGRATOR_URL ; RLS non forcée) pour tout voir.
 * Rien n'est affiché ni renvoyé d'autre que des compteurs et des identifiants de clé.
 */
import type pg from 'pg';
import { type KeyMaterial, SecretBox } from './crypto/secret-box.js';
import { routerSecretAad } from '../routers/router-secret.js';

export interface SecretFamilyReport {
  total: number;
  /** Nombre de chiffrés par identifiant de clé (« v1 » : format Sprint 1, sans identifiant). */
  byKey: Record<string, number>;
  /** Sous la clé active et déchiffrés avec elle seule. */
  activeOk: number;
  /** Sous une ancienne clé, déchiffrables : à ré-envelopper avant tout retrait. */
  previousOk: number;
  /** Indéchiffrables avec les clés fournies. */
  unreadable: number;
}

export interface KeyVerificationReport {
  activeKeyId: string;
  knownKeyIds: string[];
  routers: SecretFamilyReport;
  mfa: SecretFamilyReport;
  /** Codes de récupération non utilisés, par clé. */
  recoveryCodesByKey: Record<string, number>;
  /** Vrai seulement si plus aucune donnée ne dépend d'une ancienne clé et 0 illisible. */
  previousKeysRetirable: boolean;
}

const keyIdOf = (payload: string) => {
  const [version, kid] = payload.split(':');
  return version === 'v2' && kid ? kid : 'v1';
};

function verifyFamily(
  full: SecretBox,
  activeOnly: SecretBox,
  items: { aad: string; payload: string }[],
): SecretFamilyReport {
  const report: SecretFamilyReport = {
    total: items.length,
    byKey: {},
    activeOk: 0,
    previousOk: 0,
    unreadable: 0,
  };
  for (const item of items) {
    const kid = keyIdOf(item.payload);
    report.byKey[kid] = (report.byKey[kid] ?? 0) + 1;
    try {
      if (kid === activeOnly.activeKeyId) {
        // Valeur jetée aussitôt : seul le succès compte.
        activeOnly.decrypt(item.payload, item.aad);
        report.activeOk += 1;
      } else {
        full.decrypt(item.payload, item.aad);
        report.previousOk += 1;
      }
    } catch {
      report.unreadable += 1;
    }
  }
  return report;
}

export async function verifyEncryptionKeys(
  pool: pg.Pool | pg.PoolClient,
  keys: { active: KeyMaterial; previous: KeyMaterial[] },
): Promise<KeyVerificationReport> {
  const full = new SecretBox(keys.active.base64, { id: keys.active.id, previous: keys.previous });
  const activeOnly = new SecretBox(keys.active.base64, { id: keys.active.id });

  const routerRows = (
    await pool.query<{ company_id: string; id: string; payload: string }>(
      `select company_id, id, routeros_password_encrypted as payload
         from routers where routeros_password_encrypted is not null`,
    )
  ).rows;
  const mfaRows = (
    await pool.query<{ user_id: string | null; platform_admin_id: string | null; payload: string }>(
      'select user_id, platform_admin_id, secret_enc as payload from mfa_factors',
    )
  ).rows;
  const codes = (
    await pool.query<{ key: string; n: number }>(
      `select case when position('$' in code_hash) > 0 then split_part(code_hash, '$', 1)
              else 'v1' end as key, count(*)::int as n
         from mfa_recovery_codes where used_at is null group by 1 order by 1`,
    )
  ).rows;

  const routers = verifyFamily(
    full,
    activeOnly,
    routerRows.map((r) => ({
      aad: routerSecretAad({ companyId: r.company_id, routerId: r.id }),
      payload: r.payload,
    })),
  );
  // Mêmes données associées que MfaService et key-rotation.ts.
  const mfa = verifyFamily(
    full,
    activeOnly,
    mfaRows.map((m) => ({
      aad: m.user_id ? `mfa:user:${m.user_id}` : `mfa:platform:${m.platform_admin_id ?? ''}`,
      payload: m.payload,
    })),
  );
  const recoveryCodesByKey = Object.fromEntries(codes.map((c) => [c.key, c.n]));

  const clean = (family: SecretFamilyReport) =>
    family.unreadable === 0 && family.previousOk === 0 && family.activeOk === family.total;
  return {
    activeKeyId: full.activeKeyId,
    knownKeyIds: full.keyIds,
    routers,
    mfa,
    recoveryCodesByKey,
    previousKeysRetirable:
      clean(routers) &&
      clean(mfa) &&
      Object.keys(recoveryCodesByKey).every((key) => key === full.activeKeyId),
  };
}

/** Rapport lisible : compteurs et identifiants de clé uniquement. */
export function formatKeyVerification(report: KeyVerificationReport): string[] {
  const family = (label: string, f: SecretFamilyReport) => {
    const keys = Object.entries(f.byKey)
      .map(([key, n]) => `${key} : ${n}`)
      .join(', ');
    const ok = f.unreadable === 0 ? 'OK   ' : 'ECHEC';
    return `${ok} ${label} : ${f.total} au total (${keys || 'aucun'}) ; ${f.activeOk} sous la clé active déchiffrés avec elle seule, ${f.previousOk} encore sous une ancienne clé, ${f.unreadable} illisible(s)`;
  };
  const codes = Object.entries(report.recoveryCodesByKey)
    .map(([key, n]) => `${key} : ${n}`)
    .join(', ');
  return [
    `INFO  clé active ${report.activeKeyId} (clés fournies : ${report.knownKeyIds.join(', ')})`,
    family('mots de passe RouterOS', report.routers),
    family('secrets 2FA', report.mfa),
    `INFO  codes de récupération 2FA non utilisés, par clé : ${codes || 'aucun'}`,
    report.previousKeysRetirable
      ? 'OK    aucune donnée ne dépend plus des anciennes clés : elles peuvent être retirées de l’environnement (à conserver hors ligne tant que des sauvegardes antérieures existent).'
      : 'INFO  des données dépendent encore d’anciennes clés (ou sont illisibles) : NE PAS retirer les anciennes clés.',
  ];
}
