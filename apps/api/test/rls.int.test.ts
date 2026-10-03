/**
 * Isolation des entreprises AU NIVEAU DE POSTGRESQL, avec le rôle réel de l'API (ecsi_app),
 * sans passer par le code applicatif : même une requête SQL arbitraire sans filtre ne peut
 * ni lire, ni modifier, ni supprimer les données d'une autre entreprise.
 * Aucune base simulée : PostgreSQL 18 réel, rôles créés par infra/postgres/init.
 */
import { PERMISSION_CODES, DEFAULT_ROLE_PERMISSIONS } from '@ecsi/shared';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../src/database/migrate.js';
import { type SeedResult, seedDevData } from '../src/database/seed.js';
import { SEED_PASSWORD } from './helpers/app.js';
import { startInfra, type TestInfra } from './helpers/infra.js';

let infra: TestInfra;
let seed: SeedResult;
let invitationB: string;

const TENANT_TABLES = [
  'memberships',
  'roles',
  'role_permissions',
  'membership_roles',
  'membership_role_sites',
  'invitations',
  'invitation_roles',
  'sites',
  'site_groups',
  'site_group_members',
] as const;

const SECRET_TABLES = [
  'user_credentials',
  'platform_admins',
  'mfa_factors',
  'mfa_recovery_codes',
  'auth_sessions',
  'refresh_tokens',
  'password_reset_tokens',
] as const;

/** Exécute des requêtes avec un rôle, dans une transaction, avec un contexte tenant optionnel. */
async function as<T>(
  url: string,
  context: { companyId?: string; userId?: string },
  work: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const pool = new pg.Pool({ connectionString: url, max: 1 });
  const client = await pool.connect();
  try {
    await client.query('begin');
    if (context.companyId) {
      await client.query("select set_config('app.company_id', $1, true)", [context.companyId]);
    }
    if (context.userId) {
      await client.query("select set_config('app.user_id', $1, true)", [context.userId]);
    }
    const result = await work(client);
    await client.query('rollback');
    return result;
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

const count = async (client: pg.PoolClient, sql: string, params: unknown[] = []) =>
  Number(
    (await client.query<{ n: string }>(`select count(*)::text as n from (${sql}) q`, params))
      .rows[0]?.n,
  );

beforeAll(async () => {
  infra = await startInfra();
  await runMigrations(infra.urls.migrator);
  const pool = new pg.Pool({ connectionString: infra.urls.migrator, max: 1 });
  seed = await seedDevData(drizzle(pool, { casing: 'snake_case' }), SEED_PASSWORD);
  // Une invitation dans chaque entreprise, avec rôle, et une attribution par site.
  for (const key of ['A', 'B'] as const) {
    const { rows } = await pool.query<{ id: string }>(
      `insert into invitations (company_id, email, token_hash, expires_at)
       values ($1, $2, gen_random_bytes(32), now() + interval '7 days') returning id`,
      [seed.companies[key], `invite.${key.toLowerCase()}@ecsi.test`],
    );
    const id = rows[0]?.id ?? '';
    if (key === 'B') invitationB = id;
    await pool.query(
      `insert into invitation_roles (company_id, invitation_id, role_id) values ($1, $2, $3)`,
      [seed.companies[key], id, seed.roles[key].VENDEUR],
    );
    await pool.query(
      `insert into membership_role_sites (company_id, membership_role_id, site_id)
       select company_id, id, $2 from membership_roles where company_id = $1 limit 1
       on conflict do nothing`,
      [seed.companies[key], seed.sites[key]['SITE-A']],
    );
  }
  await pool.end();
}, 180_000);

afterAll(async () => {
  await infra.stop();
});

describe('catalogue et rôles système', () => {
  it('synchronise toutes les permissions et les rôles système de chaque entreprise', async () => {
    await as(infra.urls.migrator, {}, async (c) => {
      expect(await count(c, 'select code from permissions')).toBe(PERMISSION_CODES.length);
      for (const key of ['A', 'B'] as const) {
        const { rows } = await c.query<{ code: string; n: string }>(
          `select r.code, count(rp.*)::text as n from roles r
           left join role_permissions rp on rp.role_id = r.id
           where r.company_id = $1 and r.is_system group by r.code`,
          [seed.companies[key]],
        );
        expect(Object.fromEntries(rows.map((r) => [r.code, Number(r.n)]))).toEqual(
          Object.fromEntries(
            Object.entries(DEFAULT_ROLE_PERMISSIONS).map(([code, perms]) => [code, perms.length]),
          ),
        );
      }
      expect(await count(c, "select 1 from roles where code = 'SUPER_ADMIN'")).toBe(0);
    });
  });
});

describe('RLS : rôle ecsi_app sans contexte', () => {
  it('ne voit aucune ligne d’aucune table métier', async () => {
    await as(infra.urls.app, {}, async (c) => {
      for (const table of [...TENANT_TABLES, 'companies', 'users']) {
        expect(await count(c, `select * from ${table}`), table).toBe(0);
      }
    });
  });
});

describe('RLS : ENTREPRISE_A ne peut pas atteindre ENTREPRISE_B', () => {
  const ctxA = () => ({ companyId: seed.companies.A, userId: seed.users['gerant.a@ecsi.test'] });

  it('lecture : chaque table ne renvoie que les lignes de A, même sans filtre', async () => {
    await as(infra.urls.app, ctxA(), async (c) => {
      for (const table of TENANT_TABLES) {
        const total = await count(c, `select * from ${table}`);
        const foreign = await count(c, `select * from ${table} where company_id <> $1`, [
          seed.companies.A,
        ]);
        expect(total, table).toBeGreaterThan(0);
        expect(foreign, table).toBe(0);
      }
      expect((await c.query('select id from companies')).rows).toEqual([{ id: seed.companies.A }]);
    });
  });

  it('lecture directe par identifiant (UUID de B connu) : aucune ligne', async () => {
    await as(infra.urls.app, ctxA(), async (c) => {
      expect(await count(c, 'select * from companies where id = $1', [seed.companies.B])).toBe(0);
      expect(await count(c, 'select * from invitations where id = $1', [invitationB])).toBe(0);
      expect(
        await count(c, 'select * from users where id = $1', [seed.users['admin.b@ecsi.test']]),
      ).toBe(0);
      expect(await count(c, 'select * from roles where id = $1', [seed.roles.B.GERANT])).toBe(0);
    });
  });

  it('les utilisateurs visibles sont uniquement les membres de A', async () => {
    await as(infra.urls.app, ctxA(), async (c) => {
      const { rows } = await c.query<{ email: string }>('select email from users order by email');
      expect(rows.map((r) => r.email)).toEqual([
        'admin.a@ecsi.test',
        'gerant.a@ecsi.test',
        'gerant.site-a@ecsi.test',
        'vendeur.a@ecsi.test',
        'vendeur.site-b@ecsi.test',
      ]);
    });
  });

  it('modification : UPDATE sur les lignes de B n’affecte aucune ligne', async () => {
    await as(infra.urls.app, ctxA(), async (c) => {
      const updates = [
        ["update memberships set status = 'DISABLED' where company_id = $1", [seed.companies.B]],
        ["update invitations set status = 'REVOKED' where id = $1", [invitationB]],
        ["update companies set name = 'piraté' where id = $1", [seed.companies.B]],
        ["update roles set name = 'piraté' where id = $1", [seed.roles.B.GERANT]],
        ["update users set full_name = 'piraté' where id = $1", [seed.users['admin.b@ecsi.test']]],
        ["update sites set name = 'piraté' where id = $1", [seed.sites.B['SITE-A']]],
      ] as const;
      for (const [sql, params] of updates) {
        expect((await c.query(sql, [...params])).rowCount, sql).toBe(0);
      }
    });
  });

  it('suppression : DELETE sur les lignes de B n’affecte aucune ligne', async () => {
    await as(infra.urls.app, ctxA(), async (c) => {
      for (const table of TENANT_TABLES) {
        const result = await c.query(`delete from ${table} where company_id = $1`, [
          seed.companies.B,
        ]);
        expect(result.rowCount, table).toBe(0);
      }
    });
  });

  it('insertion : impossible d’écrire une ligne au nom de B', async () => {
    await expect(
      as(infra.urls.app, ctxA(), (c) =>
        c.query(
          `insert into invitations (company_id, email, token_hash, expires_at)
           values ($1, 'x@ecsi.test', gen_random_bytes(32), now())`,
          [seed.companies.B],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it('déplacement : impossible de transférer une ligne de A vers B', async () => {
    await expect(
      as(infra.urls.app, ctxA(), (c) =>
        c.query('update invitations set company_id = $1 where company_id = $2', [
          seed.companies.B,
          seed.companies.A,
        ]),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it('les données de B sont intactes après toutes ces tentatives', async () => {
    await as(infra.urls.migrator, {}, async (c) => {
      const { rows } = await c.query<{ status: string }>(
        'select status from invitations where id = $1',
        [invitationB],
      );
      expect(rows[0]?.status).toBe('PENDING');
      expect(
        await count(c, "select * from memberships where company_id = $1 and status = 'ACTIVE'", [
          seed.companies.B,
        ]),
      ).toBe(2);
    });
  });
});

describe('clés étrangères composites (indépendantes de la RLS)', () => {
  it('refusent d’attribuer à un membre de A un rôle de B, même pour le propriétaire', async () => {
    await expect(
      as(infra.urls.migrator, {}, (c) =>
        c.query(
          `insert into membership_roles (company_id, membership_id, role_id)
           select m.company_id, m.id, $2 from memberships m where m.company_id = $1 limit 1`,
          [seed.companies.A, seed.roles.B.ADMIN_ENTREPRISE],
        ),
      ),
    ).rejects.toThrow(/membership_roles_role_fk/);
  });

  it('refusent une permission de rôle ou une invitation incohérente entre entreprises', async () => {
    await expect(
      as(infra.urls.migrator, {}, (c) =>
        c.query(
          `insert into role_permissions (company_id, role_id, permission_code) values ($1, $2, 'users.read')`,
          [seed.companies.A, seed.roles.B.VENDEUR],
        ),
      ),
    ).rejects.toThrow(/role_permissions_role_fk/);
    await expect(
      as(infra.urls.migrator, {}, (c) =>
        c.query(
          `insert into invitation_roles (company_id, invitation_id, role_id) values ($1, $2, $3)`,
          [seed.companies.A, invitationB, seed.roles.A.VENDEUR],
        ),
      ),
    ).rejects.toThrow(/invitation_roles_invitation_fk/);
  });
});

describe('le rôle ecsi_app ne peut pas contourner la RLS', () => {
  it('n’a ni SUPERUSER ni BYPASSRLS (ecsi_app et ecsi_auth)', async () => {
    await as(infra.urls.superuser, {}, async (c) => {
      const { rows } = await c.query<{ rolname: string; rolsuper: boolean; rolbypassrls: boolean }>(
        "select rolname, rolsuper, rolbypassrls from pg_roles where rolname in ('ecsi_app', 'ecsi_auth') order by rolname",
      );
      expect(rows).toEqual([
        { rolname: 'ecsi_app', rolsuper: false, rolbypassrls: false },
        { rolname: 'ecsi_auth', rolsuper: false, rolbypassrls: false },
      ]);
    });
  });

  it('ne peut pas désactiver la RLS, supprimer une politique ni changer de rôle', async () => {
    const attempts = [
      'alter table invitations disable row level security',
      'drop policy tenant_isolation on invitations',
      'set role ecsi_migrator',
      'set role postgres',
      'set role ecsi_auth',
      'alter role ecsi_app bypassrls',
      'set session authorization ecsi_migrator',
    ];
    for (const sql of attempts) {
      await expect(
        as(infra.urls.app, {}, (c) => c.query(sql)),
        sql,
      ).rejects.toThrow(/must be owner|permission denied|must be superuser|Only roles with/);
    }
  });

  it('n’a aucun accès aux tables de secrets (mots de passe, sessions, 2FA, jetons)', async () => {
    for (const table of SECRET_TABLES) {
      await expect(
        as(infra.urls.app, { companyId: seed.companies.A }, (c) =>
          c.query(`select * from ${table}`),
        ),
        table,
      ).rejects.toThrow(/permission denied/);
    }
  });

  it('ne peut ni créer d’entreprise ou d’utilisateur, ni modifier le catalogue des permissions', async () => {
    const attempts = [
      "insert into companies (name, slug) values ('X', 'x')",
      "insert into users (email, full_name) values ('x@ecsi.test', 'X')",
      "insert into permissions (code, module, description) values ('x.y', 'x', 'x')",
      "update permissions set description = 'x'",
      'delete from companies',
    ];
    for (const sql of attempts) {
      await expect(
        as(infra.urls.app, { companyId: seed.companies.A }, (c) => c.query(sql)),
        sql,
      ).rejects.toThrow(/permission denied/);
    }
  });

  it('ecsi_auth ne peut pas modifier le schéma', async () => {
    await expect(
      as(infra.urls.auth, {}, (c) => c.query('create table x (id int)')),
    ).rejects.toThrow(/permission denied/);
    await expect(
      as(infra.urls.auth, {}, (c) => c.query('alter table users disable row level security')),
    ).rejects.toThrow(/must be owner/);
  });

  it('garde-fou : toute table du schéma public a la RLS activée', async () => {
    await as(infra.urls.superuser, {}, async (c) => {
      const { rows } = await c.query<{ relname: string }>(
        `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity order by 1`,
      );
      expect(rows).toEqual([]);
      const tenant = await c.query<{ table_name: string }>(
        `select table_name from information_schema.columns
         where table_schema = 'public' and column_name = 'company_id'`,
      );
      expect(tenant.rows.length).toBeGreaterThanOrEqual(TENANT_TABLES.length);
    });
  });
});

describe('Sprint 2 : profil d’entreprise, privilèges par colonne', () => {
  const ctxA = () => ({ companyId: seed.companies.A, userId: seed.users['admin.a@ecsi.test'] });

  it('ecsi_app modifie le profil de SON entreprise, jamais son statut ni son identifiant', async () => {
    await as(infra.urls.app, ctxA(), async (c) => {
      const ok = await c.query(
        "update companies set name = 'ENTREPRISE_A', city = 'Abidjan' where id = $1",
        [seed.companies.A],
      );
      expect(ok.rowCount).toBe(1);
    });
    const forbidden = [
      "update companies set status = 'SUSPENDED'",
      'update companies set suspended_at = now()',
      "update companies set slug = 'pirate'",
      'update companies set id = uuidv7()',
    ];
    for (const sql of forbidden) {
      await expect(
        as(infra.urls.app, ctxA(), (c) => c.query(sql)),
        sql,
      ).rejects.toThrow(/permission denied/);
    }
  });

  it('un groupe ne peut pas contenir le site d’une autre entreprise (clé composite)', async () => {
    await as(infra.urls.migrator, {}, async (c) => {
      const { rows } = await c.query<{ id: string }>(
        "insert into site_groups (company_id, name, code) values ($1, 'G', 'G-FK') returning id",
        [seed.companies.A],
      );
      await expect(
        c.query(
          'insert into site_group_members (company_id, group_id, site_id) values ($1, $2, $3)',
          [seed.companies.A, rows[0]?.id, seed.sites.B['SITE-A']],
        ),
      ).rejects.toThrow(/foreign key/);
    });
  });
});

describe('Sprint 2 : journal d’audit inaltérable', () => {
  const userA = () => seed.users['admin.a@ecsi.test'] ?? '';
  const insertEvent = (companyId: string | null, actorId: string | null, action = 'test.event') =>
    `insert into audit_events (company_id, chain_key, chain_seq, hash, actor_type, actor_id, action,
       resource_type, result)
     values (${companyId ? `'${companyId}'` : 'null'}, 'x', 0, ''::bytea, 'USER',
       ${actorId ? `'${actorId}'` : 'null'}, '${action}', 'test', 'SUCCESS')`;

  beforeAll(async () => {
    const pool = new pg.Pool({ connectionString: infra.urls.migrator, max: 1 });
    await pool.query(insertEvent(seed.companies.A, userA()));
    await pool.query(insertEvent(seed.companies.A, userA(), 'test.second'));
    await pool.query(insertEvent(seed.companies.B, seed.users['admin.b@ecsi.test'] ?? ''));
    await pool.end();
  });

  it('chaîne les événements par entreprise (numéro de séquence et empreinte calculés par la base)', async () => {
    await as(infra.urls.migrator, {}, async (c) => {
      const { rows } = await c.query<{ chain_key: string; chain_seq: string; has_prev: boolean }>(
        `select chain_key, chain_seq::text, prev_hash is not null as has_prev
         from audit_events where company_id = $1 order by chain_seq`,
        [seed.companies.A],
      );
      expect(rows.map((r) => [r.chain_key, r.chain_seq, r.has_prev])).toEqual([
        [seed.companies.A, '1', false],
        [seed.companies.A, '2', true],
      ]);
    });
    await as(infra.urls.auth, {}, async (c) => {
      expect(
        (await c.query('select * from app.audit_verify_chain($1)', [seed.companies.A])).rows,
      ).toEqual([]);
    });
  });

  it('ecsi_app ne lit que les événements de son entreprise', async () => {
    await as(infra.urls.app, { companyId: seed.companies.A, userId: userA() }, async (c) => {
      expect(await count(c, 'select * from audit_events')).toBe(2);
      expect(
        await count(c, 'select * from audit_events where company_id <> $1', [seed.companies.A]),
      ).toBe(0);
    });
  });

  it('ecsi_app n’écrit qu’au nom de l’utilisateur et de l’entreprise de la transaction', async () => {
    const ctx = { companyId: seed.companies.A, userId: userA() };
    await as(infra.urls.app, ctx, async (c) => {
      expect((await c.query(insertEvent(seed.companies.A, userA()))).rowCount).toBe(1);
    });
    for (const sql of [
      insertEvent(seed.companies.B, userA()),
      insertEvent(seed.companies.A, seed.users['gerant.a@ecsi.test'] ?? ''),
      insertEvent(null, userA()),
    ]) {
      await expect(
        as(infra.urls.app, ctx, (c) => c.query(sql)),
        sql,
      ).rejects.toThrow(/row-level security/);
    }
  });

  it('personne ne peut modifier ni supprimer un événement, pas même le propriétaire des tables', async () => {
    const ctx = { companyId: seed.companies.A, userId: userA() };
    for (const sql of ["update audit_events set action = 'x.y'", 'delete from audit_events']) {
      await expect(
        as(infra.urls.app, ctx, (c) => c.query(sql)),
        sql,
      ).rejects.toThrow(/permission denied/);
      await expect(
        as(infra.urls.auth, {}, (c) => c.query(sql)),
        sql,
      ).rejects.toThrow(/permission denied/);
      await expect(
        as(infra.urls.migrator, {}, (c) => c.query(sql)),
        sql,
      ).rejects.toThrow(/journal d.audit|append-only|interdit/i);
    }
    await expect(
      as(infra.urls.migrator, {}, (c) => c.query('truncate audit_events')),
    ).rejects.toThrow(/journal d.audit|append-only|interdit/i);
    await expect(
      as(infra.urls.app, ctx, (c) =>
        c.query('select * from app.audit_verify_chain($1)', [seed.companies.A]),
      ),
    ).rejects.toThrow(/permission denied/);
  });
});
