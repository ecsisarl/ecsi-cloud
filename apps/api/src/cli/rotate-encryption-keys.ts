/**
 * Rotation de la clé maîtresse de chiffrement (commande d'exploitation, ADR 0014).
 *
 *   1. générer une nouvelle clé : openssl rand -base64 32
 *   2. déployer avec ENCRYPTION_KEY=<nouvelle>, ENCRYPTION_KEY_ID=<nouvel id>
 *      et ENCRYPTION_PREVIOUS_KEYS=<ancien id>:<ancienne clé>
 *   3. exécuter : DATABASE_AUTH_URL=… ENCRYPTION_KEY=… ENCRYPTION_KEY_ID=… \
 *        ENCRYPTION_PREVIOUS_KEYS=… node dist/cli/rotate-encryption-keys.js [--dry-run]
 *   4. quand la commande indique que plus rien ne dépend de l'ancienne clé, la retirer de
 *      ENCRYPTION_PREVIOUS_KEYS.
 *
 * Chaque secret TOTP est ré-enveloppé avec la clé active (sa clé de données change de clé
 * d'enveloppe ; le secret lui-même n'est jamais réécrit en clair). Idempotente : un secret
 * déjà sous la clé active est ignoré. Les codes de récupération (empreintes HMAC, valeurs
 * inconnues du serveur) ne peuvent pas être recalculés : ils restent vérifiables tant que
 * leur clé est conservée ; la commande compte ceux qui en dépendent encore.
 *
 * Mots de passe RouterOS (Sprint 3A) : avec DATABASE_WORKER_URL (rôle ecsi_worker), ils sont
 * ré-enveloppés de la même façon. Sans cette variable, ils ne sont pas traités et la commande
 * ne déclare jamais les anciennes clés retirables.
 */
import { parseArgs } from 'node:util';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { z } from 'zod';
import { rotateEncryptionKeys } from '../auth/key-rotation.js';
import { parseKeyList, SecretBox } from '../auth/crypto/secret-box.js';
import { type RouterRotationReport, rotateRouterSecrets } from '../routers/router-secret.js';

const { values } = parseArgs({ options: { 'dry-run': { type: 'boolean', default: false } } });
const dryRun = values['dry-run'];

const env = z
  .object({
    DATABASE_AUTH_URL: z.string().min(1),
    DATABASE_WORKER_URL: z.string().min(1).optional(),
    ENCRYPTION_KEY: z.string().min(1),
    ENCRYPTION_KEY_ID: z.string().default('k1'),
    ENCRYPTION_PREVIOUS_KEYS: z.string().optional(),
  })
  .safeParse(process.env);
if (!env.success) {
  process.stderr.write(
    'Usage : DATABASE_AUTH_URL=… ENCRYPTION_KEY=… ENCRYPTION_KEY_ID=… [ENCRYPTION_PREVIOUS_KEYS=id:clé,…] rotate-encryption-keys [--dry-run]\n',
  );
  process.exit(1);
}

const box = new SecretBox(env.data.ENCRYPTION_KEY, {
  id: env.data.ENCRYPTION_KEY_ID,
  previous: parseKeyList(env.data.ENCRYPTION_PREVIOUS_KEYS),
});

const pool = new pg.Pool({
  connectionString: env.data.DATABASE_AUTH_URL,
  max: 1,
  application_name: 'ecsi-cli-rotate',
});

let routerReport: RouterRotationReport | null = null;
if (env.data.DATABASE_WORKER_URL) {
  const workerPool = new pg.Pool({
    connectionString: env.data.DATABASE_WORKER_URL,
    max: 1,
    application_name: 'ecsi-cli-rotate',
  });
  try {
    routerReport = await rotateRouterSecrets(drizzle(workerPool, { casing: 'snake_case' }), box, {
      dryRun,
      onError: (id, error) => process.stderr.write(`Routeur ${id} : ${error.message}\n`),
    });
  } finally {
    await workerPool.end();
  }
}

try {
  const db = drizzle(pool, { casing: 'snake_case' });
  const report = await rotateEncryptionKeys(db, box, {
    dryRun,
    // Jamais la valeur chiffrée ni la clé : uniquement l'identifiant de ligne.
    onError: (id, error) => process.stderr.write(`Facteur ${id} : ${error.message}\n`),
  });
  process.stdout.write(
    [
      `Clé active : ${box.activeKeyId} (clés connues : ${box.keyIds.join(', ')})${dryRun ? ' — simulation' : ''}`,
      `Secrets 2FA : ${report.total} au total, ${report.rewrapped} ré-enveloppés, ${report.failed} en échec.`,
      'Codes de récupération non utilisés, par clé :',
      ...report.recoveryCodesByKey.map((row) => `  - ${row.key} : ${row.count}`),
      routerReport
        ? `Mots de passe RouterOS : ${routerReport.total} au total, ${routerReport.rewrapped} ré-enveloppés, ${routerReport.failed} en échec.`
        : 'Mots de passe RouterOS : non traités (DATABASE_WORKER_URL absent).',
      report.recoveryCodesByKey.every((row) => row.key === box.activeKeyId) &&
      report.failed === 0 &&
      routerReport?.failed === 0
        ? 'Aucune donnée ne dépend plus des anciennes clés : elles peuvent être retirées.'
        : "Des données dépendent encore d'anciennes clés : conservez-les (les utilisateurs concernés peuvent régénérer leurs codes de récupération).",
      '',
    ].join('\n'),
  );
  if (report.failed > 0 || (routerReport?.failed ?? 0) > 0) process.exitCode = 1;
} finally {
  await pool.end();
}
