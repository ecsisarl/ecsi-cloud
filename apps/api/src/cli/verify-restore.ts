/**
 * Vérification d'une base RESTAURÉE (Sprint S3H, étape H1 ; ops/backup/).
 *
 *   node dist/cli/verify-restore.js --manifest
 *       Contrôle la base, puis écrit le manifeste JSON sur la sortie standard (au moment de la
 *       sauvegarde, sur la copie jetable restaurée depuis le dump). Code non nul si un contrôle
 *       échoue : la sauvegarde est alors déclarée inutilisable.
 *
 *   node dist/cli/verify-restore.js --compare < manifest.json
 *       Contrôle la base restaurée et la compare au manifeste de la sauvegarde. Avec
 *       DATABASE_MIGRATOR_URL, vérifie aussi qu'aucune migration du code n'est à rejouer.
 *
 * Variables : RESTORE_CHECK_URL (superutilisateur de la base JETABLE), ENCRYPTION_KEY,
 * ENCRYPTION_KEY_ID, ENCRYPTION_PREVIOUS_KEYS (les clés du .env de production : sans elles,
 * les échecs de déchiffrement sont comptés). Seules des lignes OK / ECHEC / INFO sont
 * affichées (sur la sortie d'erreur en mode --manifest) : jamais une donnée ni un secret.
 */
import { parseArgs } from 'node:util';
import pg from 'pg';
import { z } from 'zod';
import { parseKeyList, SecretBox } from '../auth/crypto/secret-box.js';
import { runMigrations } from '../database/migrate.js';
import {
  type CheckLine,
  checkMigrationsUpToDate,
  compareWithManifest,
  inspectDatabase,
  parseManifest,
  selfChecks,
} from '../database/restore-check.js';

const { values } = parseArgs({
  options: {
    manifest: { type: 'boolean', default: false },
    compare: { type: 'boolean', default: false },
  },
});
if (values.manifest === values.compare) {
  process.stderr.write('Usage : verify-restore --manifest | --compare < manifest.json\n');
  process.exit(2);
}

const env = z
  .object({
    RESTORE_CHECK_URL: z.string().min(1),
    DATABASE_MIGRATOR_URL: z.string().min(1).optional(),
    ENCRYPTION_KEY: z.string().min(1),
    ENCRYPTION_KEY_ID: z.string().default('k1'),
    ENCRYPTION_PREVIOUS_KEYS: z.string().optional(),
  })
  .safeParse(process.env);
if (!env.success) {
  // Noms des variables seulement, jamais leurs valeurs.
  const names = [...new Set(env.error.issues.map((issue) => issue.path.join('.')))];
  process.stderr.write(`Variables manquantes ou invalides : ${names.join(', ')}\n`);
  process.exit(2);
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

let box: SecretBox;
try {
  box = new SecretBox(env.data.ENCRYPTION_KEY, {
    id: env.data.ENCRYPTION_KEY_ID,
    previous: parseKeyList(env.data.ENCRYPTION_PREVIOUS_KEYS),
  });
} catch (error) {
  process.stderr.write(
    `Clé de chiffrement invalide : ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(2);
}

const report = values.manifest ? process.stderr : process.stdout;
const print = (lines: CheckLine[]) => {
  report.write(lines.map((line) => `${line.status.padEnd(5)} ${line.label}\n`).join(''));
};

const pool = new pg.Pool({
  connectionString: env.data.RESTORE_CHECK_URL,
  max: 1,
  application_name: 'ecsi-verify-restore',
});
try {
  const manifest = values.compare ? parseManifest(await readStdin()) : null;
  const state = await inspectDatabase(pool, box);
  const lines = manifest ? compareWithManifest(state, manifest) : selfChecks(state);
  lines.unshift({
    status: 'INFO',
    label: `clé active ${box.activeKeyId} (clés connues : ${box.keyIds.join(', ')})`,
  });
  const migratorUrl = env.data.DATABASE_MIGRATOR_URL;
  if (manifest && migratorUrl) {
    const countMigrations = async () =>
      (
        await pool.query<{ n: number }>(
          'select count(*)::int as n from drizzle.__drizzle_migrations',
        )
      ).rows[0]?.n ?? 0;
    lines.push(await checkMigrationsUpToDate(migratorUrl, countMigrations, runMigrations));
  }
  print(lines);
  const failed = lines.filter((line) => line.status === 'ECHEC').length;
  report.write(
    failed === 0
      ? 'RESULTAT : base restaurée conforme.\n'
      : `RESULTAT : ${failed} contrôle(s) en échec.\n`,
  );
  if (failed > 0) {
    process.exitCode = 1;
  } else if (values.manifest) {
    process.stdout.write(`${JSON.stringify(state, null, 2)}\n`);
  }
} catch (error) {
  process.stderr.write(
    `ECHEC vérification impossible : ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
} finally {
  await pool.end();
}
