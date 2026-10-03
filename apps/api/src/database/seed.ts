/**
 * Données de démonstration (DÉVELOPPEMENT ET TESTS UNIQUEMENT) : deux entreprises isolées,
 * ENTREPRISE_A et ENTREPRISE_B, avec des utilisateurs de rôles différents. Utilisées par
 * les tests E2E et pour essayer le dashboard. Idempotent : chaque exécution remet les comptes
 * de démonstration dans leur état initial (mot de passe, rôles, 2FA, sessions). Refusé en production.
 *
 *   DATABASE_MIGRATOR_URL=… SEED_PASSWORD=… node dist/database/seed.js
 */
import { fileURLToPath } from 'node:url';
import type { CompanySystemRole } from '@ecsi/shared';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { hashPassword } from '../auth/crypto/password.js';
import { ensureSystemRoles } from './catalog.js';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import {
  authSessions,
  companies,
  membershipRoleSites,
  membershipRoles,
  memberships,
  mfaFactors,
  mfaRecoveryCodes,
  platformAdmins,
  siteGroupMembers,
  siteGroups,
  sites,
  userCredentials,
  users,
} from './schema/index.js';

export const SEED_COMPANIES = {
  A: { slug: 'entreprise-a', name: 'ENTREPRISE_A' },
  B: { slug: 'entreprise-b', name: 'ENTREPRISE_B' },
} as const;

/** Sites de démonstration. Le code SITE-A existe dans les deux entreprises (unicité par entreprise). */
export const SEED_SITES = {
  A: [
    { code: 'SITE-A', name: 'Cocody Riviera', city: 'Abidjan' },
    { code: 'SITE-B', name: 'Yopougon Selmer', city: 'Abidjan' },
  ],
  B: [{ code: 'SITE-A', name: 'Plateau Centre (B)', city: 'Abidjan' }],
} as const;

/** Groupe de roaming de démonstration (ENTREPRISE_A) : contient SITE-A et SITE-B. */
export const SEED_GROUP = { code: 'GROUPE-ABIDJAN', name: 'Abidjan', sites: ['SITE-A', 'SITE-B'] };

/** Super administrateur ECSI de démonstration (realm plateforme). */
export const SEED_PLATFORM_ADMIN = { email: 'superadmin@ecsi.test', fullName: 'Super Admin ECSI' };

export const SEED_USERS: readonly {
  email: string;
  fullName: string;
  company: keyof typeof SEED_COMPANIES;
  role: CompanySystemRole;
  /** Portée limitée à ces sites (codes) ; absente : toute l'entreprise. */
  sites?: readonly string[];
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
  {
    email: 'gerant.site-a@ecsi.test',
    fullName: 'Serge Gérant (SITE-A)',
    company: 'A',
    role: 'GERANT',
    sites: ['SITE-A'],
  },
  {
    email: 'vendeur.site-b@ecsi.test',
    fullName: 'Mariam Vendeuse (SITE-B)',
    company: 'A',
    role: 'VENDEUR',
    sites: ['SITE-B'],
  },
];

export interface SeedResult {
  companies: Record<keyof typeof SEED_COMPANIES, string>;
  users: Record<string, string>;
  roles: Record<keyof typeof SEED_COMPANIES, Record<string, string>>;
  /** Identifiants des sites par entreprise puis par code. */
  sites: Record<keyof typeof SEED_COMPANIES, Record<string, string>>;
  groupId: string;
  platformAdminId: string;
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
      sites: { A: {}, B: {} },
      groupId: '',
      platformAdminId: '',
    };
    for (const key of ['A', 'B'] as const) {
      const spec = SEED_COMPANIES[key];
      const [company] = await tx
        .insert(companies)
        .values(spec)
        .onConflictDoUpdate({
          target: companies.slug,
          set: { name: spec.name, status: 'ACTIVE', suspendedAt: null, suspensionReason: null },
        })
        .returning({ id: companies.id });
      if (!company) throw new Error('Entreprise non créée');
      result.companies[key] = company.id;
      result.roles[key] = await ensureSystemRoles(tx, company.id);
      for (const site of SEED_SITES[key]) {
        const values = {
          name: site.name,
          city: site.city,
          country: 'CI',
          timezone: 'Africa/Abidjan',
          status: 'ACTIVE',
        };
        const [existing] = await tx
          .select({ id: sites.id })
          .from(sites)
          .where(
            and(
              eq(sites.companyId, company.id),
              eq(sites.code, site.code),
              isNull(sites.deletedAt),
            ),
          );
        if (existing) {
          await tx.update(sites).set(values).where(eq(sites.id, existing.id));
          result.sites[key][site.code] = existing.id;
        } else {
          const [created] = await tx
            .insert(sites)
            .values({ ...values, companyId: company.id, code: site.code })
            .returning({ id: sites.id });
          if (!created) throw new Error('Site non créé');
          result.sites[key][site.code] = created.id;
        }
      }
    }
    const [group] = await tx
      .insert(siteGroups)
      .values({ companyId: result.companies.A, code: SEED_GROUP.code, name: SEED_GROUP.name })
      .onConflictDoUpdate({
        target: [siteGroups.companyId, siteGroups.code],
        set: { name: SEED_GROUP.name },
      })
      .returning({ id: siteGroups.id });
    if (!group) throw new Error('Groupe non créé');
    result.groupId = group.id;
    await tx.delete(siteGroupMembers).where(eq(siteGroupMembers.groupId, group.id));
    await tx.insert(siteGroupMembers).values(
      SEED_GROUP.sites.map((code) => ({
        companyId: result.companies.A,
        groupId: group.id,
        siteId: result.sites.A[code] ?? '',
      })),
    );
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
      // Rôles remis à l'état initial (les tests peuvent les modifier).
      await tx.delete(membershipRoles).where(eq(membershipRoles.membershipId, membership.id));
      const [membershipRole] = await tx
        .insert(membershipRoles)
        .values({
          companyId,
          membershipId: membership.id,
          roleId,
          scope: spec.sites ? 'SITES' : 'COMPANY',
        })
        .returning({ id: membershipRoles.id });
      if (!membershipRole) throw new Error('Rôle non attribué');
      if (spec.sites) {
        await tx.insert(membershipRoleSites).values(
          spec.sites.map((code) => {
            const siteId = result.sites[spec.company][code];
            if (!siteId) throw new Error(`Site ${code} inconnu`);
            return { companyId, membershipRoleId: membershipRole.id, siteId };
          }),
        );
      }
    }
    const [admin] = await tx
      .insert(platformAdmins)
      .values({ ...SEED_PLATFORM_ADMIN, passwordHash })
      .onConflictDoUpdate({
        target: platformAdmins.email,
        set: { fullName: SEED_PLATFORM_ADMIN.fullName, passwordHash, status: 'ACTIVE' },
      })
      .returning({ id: platformAdmins.id });
    if (!admin) throw new Error('Super administrateur non créé');
    result.platformAdminId = admin.id;
    await tx.delete(mfaFactors).where(eq(mfaFactors.platformAdminId, admin.id));
    await tx.delete(mfaRecoveryCodes).where(eq(mfaRecoveryCodes.platformAdminId, admin.id));
    await tx.delete(authSessions).where(eq(authSessions.platformAdminId, admin.id));
    // Comptes de démonstration remis à zéro : 2FA à reconfigurer, sessions fermées.
    const demoUsers = Object.values(result.users);
    await tx.delete(mfaFactors).where(inArray(mfaFactors.userId, demoUsers));
    await tx.delete(mfaRecoveryCodes).where(inArray(mfaRecoveryCodes.userId, demoUsers));
    await tx.delete(authSessions).where(inArray(authSessions.userId, demoUsers));
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
        `Données de démonstration créées : ${SEED_USERS.map((u) => u.email).join(', ')}, ${SEED_PLATFORM_ADMIN.email} (plateforme)\n`,
      );
    })
    .catch((error: unknown) => {
      process.stderr.write(`Échec : ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    })
    .finally(() => void pool.end());
}
