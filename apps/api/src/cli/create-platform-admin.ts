/**
 * Création d'un super administrateur ECSI (commande d'exploitation, jamais exposée par l'API).
 *
 *   PLATFORM_ADMIN_PASSWORD=… DATABASE_MIGRATOR_URL=… \
 *     node dist/cli/create-platform-admin.js --email ops@ecsi.ci --name "Nom Prénom"
 *
 * Le mot de passe est lu dans l'environnement (jamais en argument : il apparaîtrait dans
 * l'historique du shell et la liste des processus). La 2FA est exigée dès la première connexion.
 */
import { parseArgs } from 'node:util';
import { emailSchema, passwordSchema } from '@ecsi/shared';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { hashPassword } from '../auth/crypto/password.js';
import { platformAdmins } from '../database/schema/index.js';

const { values } = parseArgs({
  options: { email: { type: 'string' }, name: { type: 'string' } },
});

const email = emailSchema.safeParse(values.email);
const password = passwordSchema.safeParse(process.env.PLATFORM_ADMIN_PASSWORD);
const url = process.env.DATABASE_MIGRATOR_URL;

if (!email.success || !values.name || !password.success || !url) {
  process.stderr.write(
    'Usage : PLATFORM_ADMIN_PASSWORD=… (12+ caractères) DATABASE_MIGRATOR_URL=… create-platform-admin --email <e-mail> --name <nom>\n',
  );
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: url, max: 1, application_name: 'ecsi-cli' });
try {
  const db = drizzle(pool, { casing: 'snake_case' });
  const [admin] = await db
    .insert(platformAdmins)
    .values({
      email: email.data,
      fullName: values.name,
      passwordHash: await hashPassword(password.data),
    })
    .onConflictDoNothing()
    .returning({ id: platformAdmins.id });
  if (!admin) {
    process.stderr.write('Un super administrateur existe déjà avec cette adresse.\n');
    process.exitCode = 1;
  } else {
    process.stdout.write(
      `Super administrateur créé (${admin.id}). 2FA exigée à la première connexion.\n`,
    );
  }
} finally {
  await pool.end();
}
