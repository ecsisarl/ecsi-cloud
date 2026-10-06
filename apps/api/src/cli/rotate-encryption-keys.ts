/**
 * Rotation de la clé maîtresse de chiffrement (commande d'exploitation, ADR 0014 ; procédure
 * complète : docs/SECURITY.md, « Rotation de la clé de chiffrement », Sprint S3H-H2).
 *
 *   node dist/cli/rotate-encryption-keys.js --verify     contrôle en lecture seule
 *   node dist/cli/rotate-encryption-keys.js --dry-run    simulation (ré-enveloppe contrôlée, rien n'est écrit)
 *   node dist/cli/rotate-encryption-keys.js              rotation, puis contrôle
 *
 * En Compose : docker compose --profile ops run --rm keys-rotate [--verify | --dry-run].
 *
 * Variables : ENCRYPTION_KEY / ENCRYPTION_KEY_ID (clé ACTIVE, la nouvelle) et
 * ENCRYPTION_PREVIOUS_KEYS (anciennes clés, id:base64,…) ; DATABASE_MIGRATOR_URL (propriétaire
 * des tables : voit tous les routeurs, y compris supprimés ; contrôle et mots de passe
 * RouterOS) ; DATABASE_AUTH_URL (secrets 2FA, rôle ecsi_auth) ; DATABASE_WORKER_URL (repli
 * pour les mots de passe RouterOS sans DATABASE_MIGRATOR_URL : routeurs actifs seulement).
 *
 * Chaque secret est ré-enveloppé avec la clé active seulement s'il se déchiffre avant ET
 * après, à l'identique (SecretBox.rewrapVerified) ; l'écriture est conditionnelle (un secret
 * modifié entre-temps n'est pas écrasé). Idempotente. Aucune clé n'est jamais retirée par la
 * commande : elle indique seulement si plus rien ne dépend des anciennes clés (contrôle
 * --verify : tout sous la clé active, déchiffré avec elle seule, 0 illisible). Les codes de
 * récupération 2FA (empreintes HMAC) ne peuvent pas être ré-enveloppés : ils sont comptés par
 * clé et bloquent le retrait tant qu'ils dépendent d'une ancienne clé.
 *
 * Sorties : compteurs et identifiants de clé uniquement, jamais une clé ni un secret.
 */
import { parseArgs } from 'node:util';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { z } from 'zod';
import { rotateEncryptionKeys } from '../auth/key-rotation.js';
import { formatKeyVerification, verifyEncryptionKeys } from '../auth/key-verification.js';
import { parseKeyList, SecretBox } from '../auth/crypto/secret-box.js';
import { type RouterRotationReport, rotateRouterSecrets } from '../routers/router-secret.js';

const { values } = parseArgs({
  options: {
    'dry-run': { type: 'boolean', default: false },
    verify: { type: 'boolean', default: false },
  },
});
const dryRun = values['dry-run'];
const verifyOnly = values.verify;
if (dryRun && verifyOnly) {
  process.stderr.write('Usage : rotate-encryption-keys [--verify | --dry-run]\n');
  process.exit(2);
}

const env = z
  .object({
    DATABASE_AUTH_URL: z.string().min(1).optional(),
    DATABASE_WORKER_URL: z.string().min(1).optional(),
    DATABASE_MIGRATOR_URL: z.string().min(1).optional(),
    ENCRYPTION_KEY: z.string().min(1),
    ENCRYPTION_KEY_ID: z.string().default('k1'),
    ENCRYPTION_PREVIOUS_KEYS: z.string().optional(),
  })
  .safeParse(process.env);
function missing(names: string[]): never {
  process.stderr.write(`Variables manquantes ou invalides : ${names.join(', ')}\n`);
  process.exit(2);
}
if (!env.success) missing([...new Set(env.error.issues.map((issue) => issue.path.join('.')))]);
const config = env.data;
const migratorUrl = config.DATABASE_MIGRATOR_URL;
const authUrl = config.DATABASE_AUTH_URL;
if (verifyOnly && !migratorUrl) missing(['DATABASE_MIGRATOR_URL']);
if (!verifyOnly && !authUrl) missing(['DATABASE_AUTH_URL']);

const keys = {
  active: { id: config.ENCRYPTION_KEY_ID, base64: config.ENCRYPTION_KEY },
  previous: parseKeyList(config.ENCRYPTION_PREVIOUS_KEYS),
};
let box: SecretBox;
try {
  box = new SecretBox(keys.active.base64, { id: keys.active.id, previous: keys.previous });
} catch (error) {
  // Message de validation (format, longueur, doublon) : jamais la valeur.
  process.stderr.write(
    `Clés de chiffrement invalides : ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(2);
}

const out = (lines: string[]) => process.stdout.write(`${lines.join('\n')}\n`);
const pool = (url: string) =>
  new pg.Pool({ connectionString: url, max: 1, application_name: 'ecsi-cli-rotate' });

async function verify(url: string): Promise<boolean> {
  const migrator = pool(url);
  try {
    const report = await verifyEncryptionKeys(migrator, keys);
    out(['Contrôle (lecture seule) :', ...formatKeyVerification(report)]);
    return report.routers.unreadable === 0 && report.mfa.unreadable === 0;
  } finally {
    await migrator.end();
  }
}

async function rotate(url: string): Promise<boolean> {
  out([
    `Clé active : ${box.activeKeyId} (clés connues : ${box.keyIds.join(', ')})${dryRun ? ' — SIMULATION, rien n’est écrit' : ''}`,
  ]);
  let routerReport: RouterRotationReport | null = null;
  const routersUrl = migratorUrl ?? config.DATABASE_WORKER_URL;
  if (routersUrl) {
    const routersPool = pool(routersUrl);
    try {
      routerReport = await rotateRouterSecrets(
        drizzle(routersPool, { casing: 'snake_case' }),
        box,
        {
          dryRun,
          onError: (id, error) => process.stderr.write(`Routeur ${id} : ${error.message}\n`),
        },
      );
    } finally {
      await routersPool.end();
    }
  }
  const authPool = pool(url);
  try {
    const report = await rotateEncryptionKeys(drizzle(authPool, { casing: 'snake_case' }), box, {
      dryRun,
      // Jamais la valeur chiffrée ni la clé : uniquement l'identifiant de ligne.
      onError: (id, error) => process.stderr.write(`Facteur ${id} : ${error.message}\n`),
    });
    const verb = dryRun ? 'à ré-envelopper (contrôlés)' : 'ré-enveloppés (contrôlés)';
    out([
      `Secrets 2FA : ${report.total} au total, ${report.rewrapped} ${verb}, ${report.skipped} modifiés pendant la rotation, ${report.failed} en échec.`,
      routerReport
        ? `Mots de passe RouterOS : ${routerReport.total} au total, ${routerReport.rewrapped} ${verb}, ${routerReport.skipped} modifiés pendant la rotation, ${routerReport.failed} en échec${migratorUrl ? '' : ' (routeurs actifs seulement : DATABASE_MIGRATOR_URL absent)'}.`
        : 'Mots de passe RouterOS : non traités (DATABASE_MIGRATOR_URL et DATABASE_WORKER_URL absents).',
    ]);
    return report.failed === 0 && (routerReport?.failed ?? 0) === 0 && routerReport !== null;
  } finally {
    await authPool.end();
  }
}

try {
  let ok = verifyOnly ? await verify(migratorUrl ?? '') : await rotate(authUrl ?? '');
  if (!verifyOnly) {
    if (migratorUrl) ok = (await verify(migratorUrl)) && ok;
    else out(['Contrôle non exécuté (DATABASE_MIGRATOR_URL absent) : ne retirez aucune clé.']);
  }
  if (!ok) process.exitCode = 1;
} catch (error) {
  process.stderr.write(`Échec : ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
