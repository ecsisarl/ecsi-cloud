/**
 * Données de démonstration (DÉVELOPPEMENT ET TESTS UNIQUEMENT) : deux entreprises isolées,
 * ENTREPRISE_A et ENTREPRISE_B, avec des utilisateurs de rôles différents. Utilisées par
 * les tests E2E et pour essayer le dashboard. Idempotent. Refusé en production.
 *
 *   DATABASE_MIGRATOR_URL=… SEED_PASSWORD=… node dist/database/seed.js
 */
import { fileURLToPath } from 'node:url';
import type { CompanySystemRole } from '@ecsi/shared';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { hashPassword } from '../auth/crypto/password.js';
import { ensureSystemRoles } from './catalog.js';
import { companies, membershipRoles, memberships, userCredentials, users } from './schema/index.js';

export const SEED_COMPANIES = {
  A: { slug: 'entreprise-a', name: 'ENTREPRISE_A' },
  B: { slug: 'entreprise-b', name: 'ENTREPRISE_B' },
} as const;

export const SEED_USERS: readonly {
  email: string;
  fullName: string;
  company: keyof typeof SEED_COMPANIES;
  role: CompanySystemRole;
}[] = [
  { email: 'admin.a@ecsi.test', fullName: 'Awa Admin (A)', company: 'A', role: 'ADMIN_ENTREPRISE' },
  { email: 'gerant.a@ecsi.test', fullName: 'Koffi Gérant (A)', company: 'A', role: 'GERANT' },
  { email: 'vendeur.a@ecsi.test', fullName: 'Aya Vendeuse (A)', company: 'A', role: 'VENDEUR' },
  {
    email: 'admin.b@ecsi.test',
    fullName: 'Bakary Admin (B)',
    company: 'B',
    role: 'ADMIN_ENTREPRISE',
  },
  { email: 'gerant.b@ecsi.test', fullName: 'Fatou Gérante (B)', company: 'B', role: 'GERANT' },
];

export interface SeedResult {
  companies: Record<keyof typeof SEED_COMPANIES, string>;
  users: Record<string, string>;
  roles: Record<keyof typeof SEED_COMPANIES, Record<string, string>>;
}

export async function seedDevData(
  db: NodePgDatabase<Record<string, unknown>>,
  password: string,
): Promise<SeedResult> {
  const passwordHash = await hashPassword(password);
  return db.transaction(async (tx) => {
    const result: SeedResult = {
      companies: { A: '', B: '' },
      users: {},
      roles: { A: {}, B: {} },
    };
    for (const key of ['A', 'B'] as const) {
      const spec = SEED_COMPANIES[key];
      const [company] = await tx
        .insert(companies)
        .values(spec)
        .onConflictDoUpdate({ target: companies.slug, set: { name: spec.name } })
        .returning({ id: companies.id });
      if (!company) throw new Error('Entreprise non créée');
      result.companies[key] = company.id;
      result.roles[key] = await ensureSystemRoles(tx, company.id);
    }
    for (const spec of SEED_USERS) {
      const [user] = await tx
        .insert(users)
        .values({ email: spec.email, fullName: spec.fullName })
        .onConflictDoUpdate({
          target: users.email,
          set: { fullName: spec.fullName, status: 'ACTIVE' },
        })
        .returning({ id: users.id });
      if (!user) throw new Error('Utilisateur non créé');
      result.users[spec.email] = user.id;
      await tx
        .insert(userCredentials)
        .values({ userId: user.id, passwordHash })
        .onConflictDoUpdate({ target: userCredentials.userId, set: { passwordHash } });
      const companyId = result.companies[spec.company];
      const [membership] = await tx
        .insert(memberships)
        .values({ companyId, userId: user.id })
        .onConflictDoUpdate({
          target: [memberships.companyId, memberships.userId],
          set: { status: 'ACTIVE' },
        })
        .returning({ id: memberships.id });
      const roleId = result.roles[spec.company][spec.role];
      if (!membership || !roleId) throw new Error('Appartenance non créée');
      await tx
        .insert(membershipRoles)
        .values({ companyId, membershipId: membership.id, roleId, scope: 'COMPANY' })
        .onConflictDoNothing();
    }
    return result;
  });
}

const isEntrypoint = process.argv[1] === fileURLToPath(import.meta.url);
if (isEntrypoint) {
  const url = process.env.DATABASE_MIGRATOR_URL;
  const password = process.env.SEED_PASSWORD;
  if (process.env.NODE_ENV === 'production') {
    process.stderr.write('Le jeu de données de démonstration est interdit en production.\n');
    process.exit(1);
  }
  if (!url || !password || password.length < 12) {
    process.stderr.write(
      'DATABASE_MIGRATOR_URL et SEED_PASSWORD (12 caractères minimum) sont requis.\n',
    );
    process.exit(1);
  }
  const pool = new pg.Pool({ connectionString: url, max: 1, application_name: 'ecsi-seed' });
  seedDevData(drizzle(pool, { casing: 'snake_case' }), password)
    .then(() => {
      process.stdout.write(
        `Données de démonstration créées : ${SEED_USERS.map((u) => u.email).join(', ')}\n`,
      );
    })
    .catch((error: unknown) => {
      process.stderr.write(`Échec : ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    })
    .finally(() => void pool.end());
}
