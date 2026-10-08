/**
 * Inspection d'une base RESTAURÉE (Sprint S3H, étape H1) : ce qui prouve qu'une sauvegarde
 * est réellement utilisable, sans jamais afficher de donnée ni de secret.
 *
 *  - nombre de lignes par table, Row-Level Security et politiques par table ;
 *  - rôles ECSI et empreinte des droits (tables, fonctions, privilèges par défaut) ;
 *  - migrations appliquées ;
 *  - chaînes du journal d'audit (app.audit_verify_chain) ;
 *  - déchiffrement de CHAQUE mot de passe RouterOS et de CHAQUE secret 2FA avec les clés
 *    fournies : seuls des compteurs sortent (réussites, échecs, encore sous une ancienne clé).
 *
 * Se connecte avec le superutilisateur de la base JETABLE (les politiques RLS ne doivent pas
 * masquer de lignes au comptage). Lecture seule : les migrations sont vérifiées à part
 * (checkMigrationsUpToDate) par le rôle propriétaire.
 */
import { createHash } from 'node:crypto';
import type pg from 'pg';
import type { SecretBox } from '../auth/crypto/secret-box.js';
import { routerSecretAad } from '../routers/router-secret.js';

export const MANIFEST_FORMAT = 'ecsi-restore-manifest/1';

export interface TableState {
  /** « schéma.table » */
  name: string;
  rows: number;
  rls: boolean;
  forceRls: boolean;
  policies: number;
}

export interface SecretCount {
  total: number;
  ok: number;
  failed: number;
  /** Déchiffrables, mais encore sous une ancienne clé (rotation inachevée). */
  previousKey: number;
}

export interface DatabaseState {
  /** MANIFEST_FORMAT (chaîne libre ici : un manifeste lu peut être d'un autre format). */
  format: string;
  postgresMajor: number;
  tables: TableState[];
  roles: string[];
  grantsDigest: string;
  migrations: number;
  audit: { chains: number; events: number; broken: number };
  secrets: { routers: SecretCount; mfa: SecretCount };
}

const ECSI_ROLES = ['ecsi_app', 'ecsi_auth', 'ecsi_migrator', 'ecsi_worker'];

async function rows<T extends pg.QueryResultRow>(
  client: pg.Pool | pg.PoolClient,
  text: string,
  values: unknown[] = [],
): Promise<T[]> {
  return (await client.query<T>(text, values)).rows;
}

async function one<T extends pg.QueryResultRow>(
  client: pg.Pool | pg.PoolClient,
  text: string,
  values: unknown[] = [],
): Promise<T> {
  const [row] = await rows<T>(client, text, values);
  if (!row) throw new Error('requête sans résultat');
  return row;
}

function countSecrets(box: SecretBox, items: { aad: string; payload: string }[]): SecretCount {
  const count: SecretCount = { total: items.length, ok: 0, failed: 0, previousKey: 0 };
  for (const item of items) {
    try {
      // Valeur déchiffrée jetée aussitôt : seul le succès compte.
      box.decrypt(item.payload, item.aad);
      count.ok += 1;
      if (box.needsRewrap(item.payload)) count.previousKey += 1;
    } catch {
      count.failed += 1;
    }
  }
  return count;
}

const quoteIdent = (value: string) => `"${value.replaceAll('"', '""')}"`;

export async function inspectDatabase(
  pool: pg.Pool | pg.PoolClient,
  box: SecretBox,
): Promise<DatabaseState> {
  const { major } = await one<{ major: number }>(
    pool,
    `select current_setting('server_version_num')::int / 10000 as major`,
  );

  const tableRows = await rows<{
    schema: string;
    table: string;
    rls: boolean;
    force_rls: boolean;
    policies: number;
  }>(
    pool,
    `select n.nspname as schema, c.relname as table, c.relrowsecurity as rls,
            c.relforcerowsecurity as force_rls,
            (select count(*)::int from pg_policy p where p.polrelid = c.oid) as policies
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where c.relkind in ('r', 'p')
        and n.nspname not in ('pg_catalog', 'information_schema')
        and n.nspname not like 'pg_toast%'
      order by 1, 2`,
  );
  const tables: TableState[] = [];
  for (const t of tableRows) {
    const { n } = await one<{ n: number }>(
      pool,
      `select count(*)::int as n from ${quoteIdent(t.schema)}.${quoteIdent(t.table)}`,
    );
    tables.push({
      name: `${t.schema}.${t.table}`,
      rows: n,
      rls: t.rls,
      forceRls: t.force_rls,
      policies: t.policies,
    });
  }

  const roles = (
    await rows<{ rolname: string }>(
      pool,
      `select rolname from pg_roles where rolname = any($1) order by 1`,
      [ECSI_ROLES],
    )
  ).map((r) => r.rolname);

  // Empreinte des droits accordés aux rôles ECSI : tables, colonnes, fonctions, schémas et
  // privilèges par défaut. Une restauration qui perd un GRANT change l'empreinte.
  const grants = await rows<{ line: string }>(
    pool,
    `select line from (
       select format('table %s.%s %s %s', table_schema, table_name, grantee, privilege_type) as line
         from information_schema.role_table_grants where grantee = any($1)
       union all
       select format('column %s.%s.%s %s %s', table_schema, table_name, column_name, grantee, privilege_type)
         from information_schema.column_privileges where grantee = any($1)
       union all
       select format('routine %s.%s %s %s', routine_schema, routine_name, grantee, privilege_type)
         from information_schema.role_routine_grants where grantee = any($1)
       union all
       select format('schema %s %s', n.nspname, a.privilege_type)
         from pg_namespace n, aclexplode(n.nspacl) a
         join pg_roles r on r.oid = a.grantee where r.rolname = any($1)
       union all
       select format('default %s %s %s', d.defaclobjtype, r.rolname, a.privilege_type)
         from pg_default_acl d, aclexplode(d.defaclacl) a
         join pg_roles r on r.oid = a.grantee where r.rolname = any($1)
     ) g order by line`,
    [ECSI_ROLES],
  );
  const grantsDigest = createHash('sha256')
    .update(grants.map((g) => g.line).join('\n'))
    .digest('hex');

  const { migrations } = await one<{ migrations: number }>(
    pool,
    `select case when to_regclass('drizzle.__drizzle_migrations') is null then 0
            else (select count(*)::int from drizzle.__drizzle_migrations) end as migrations`,
  );

  const chains = await rows<{ chain_key: string; events: number }>(
    pool,
    `select chain_key, count(*)::int as events from public.audit_events group by chain_key order by 1`,
  );
  let broken = 0;
  for (const chain of chains) {
    const { n } = await one<{ n: number }>(
      pool,
      `select count(*)::int as n from app.audit_verify_chain($1)`,
      [chain.chain_key],
    );
    broken += n;
  }

  const routerSecrets = await rows<{ company_id: string; id: string; payload: string }>(
    pool,
    `select company_id, id, routeros_password_encrypted as payload
       from routers where routeros_password_encrypted is not null`,
  );
  const mfaSecrets = await rows<{
    user_id: string | null;
    platform_admin_id: string | null;
    payload: string;
  }>(pool, `select user_id, platform_admin_id, secret_enc as payload from mfa_factors`);

  return {
    format: MANIFEST_FORMAT,
    postgresMajor: major,
    tables,
    roles,
    grantsDigest,
    migrations,
    audit: {
      chains: chains.length,
      events: chains.reduce((sum, c) => sum + c.events, 0),
      broken,
    },
    secrets: {
      routers: countSecrets(
        box,
        routerSecrets.map((r) => ({
          aad: routerSecretAad({ companyId: r.company_id, routerId: r.id }),
          payload: r.payload,
        })),
      ),
      // Mêmes données associées que MfaService et key-rotation.ts.
      mfa: countSecrets(
        box,
        mfaSecrets.map((m) => ({
          aad: m.user_id ? `mfa:user:${m.user_id}` : `mfa:platform:${m.platform_admin_id ?? ''}`,
          payload: m.payload,
        })),
      ),
    },
  };
}

export type CheckStatus = 'OK' | 'ECHEC' | 'INFO';
export interface CheckLine {
  status: CheckStatus;
  label: string;
}

/** Contrôles d'une base restaurée seule (sans manifeste de référence). */
export function selfChecks(state: DatabaseState): CheckLine[] {
  const lines: CheckLine[] = [];
  const check = (ok: boolean, label: string) => lines.push({ status: ok ? 'OK' : 'ECHEC', label });
  check(
    ECSI_ROLES.every((r) => state.roles.includes(r)),
    `rôles ECSI présents (${state.roles.length}/${ECSI_ROLES.length})`,
  );
  check(state.migrations > 0, `migrations enregistrées (${state.migrations})`);
  const withRls = state.tables.filter((t) => t.rls);
  check(withRls.length > 0, `Row-Level Security active sur ${withRls.length} tables`);
  check(
    state.audit.broken === 0,
    `journal d'audit : ${state.audit.chains} chaînes, ${state.audit.events} événements, ${state.audit.broken} maillon(s) rompu(s)`,
  );
  for (const [label, count] of [
    ['mots de passe RouterOS', state.secrets.routers],
    ['secrets 2FA', state.secrets.mfa],
  ] as const) {
    check(
      count.failed === 0,
      `${label} : ${count.ok}/${count.total} déchiffrés, ${count.failed} échec(s)`,
    );
    if (count.previousKey > 0) {
      lines.push({
        status: 'INFO',
        label: `${label} : ${count.previousKey} encore sous une ancienne clé`,
      });
    }
  }
  return lines;
}

/** Comparaison avec le manifeste écrit au moment de la sauvegarde. */
export function compareWithManifest(state: DatabaseState, manifest: DatabaseState): CheckLine[] {
  const lines: CheckLine[] = [];
  const check = (ok: boolean, label: string) => lines.push({ status: ok ? 'OK' : 'ECHEC', label });
  check(manifest.format === MANIFEST_FORMAT, `format du manifeste (${manifest.format})`);
  check(
    state.postgresMajor === manifest.postgresMajor,
    `PostgreSQL ${state.postgresMajor} (sauvegarde : ${manifest.postgresMajor})`,
  );
  const expected = new Map(manifest.tables.map((t) => [t.name, t]));
  const actual = new Map(state.tables.map((t) => [t.name, t]));
  const missing = [...expected.keys()].filter((name) => !actual.has(name));
  const extra = [...actual.keys()].filter((name) => !expected.has(name));
  check(
    missing.length === 0 && extra.length === 0,
    `tables : ${actual.size} (sauvegarde : ${expected.size})` +
      (missing.length ? ` ; absentes : ${missing.join(', ')}` : '') +
      (extra.length ? ` ; en trop : ${extra.join(', ')}` : ''),
  );
  const rowDiffs = [...expected.values()].filter((t) => actual.get(t.name)?.rows !== t.rows);
  check(
    rowDiffs.length === 0,
    `nombre de lignes identique pour ${expected.size - rowDiffs.length}/${expected.size} tables` +
      (rowDiffs.length ? ` ; différent : ${rowDiffs.map((t) => t.name).join(', ')}` : ''),
  );
  const rlsDiffs = [...expected.values()].filter((t) => {
    const a = actual.get(t.name);
    return !a || a.rls !== t.rls || a.forceRls !== t.forceRls || a.policies !== t.policies;
  });
  check(
    rlsDiffs.length === 0,
    `RLS et politiques identiques` +
      (rlsDiffs.length ? ` ; différent : ${rlsDiffs.map((t) => t.name).join(', ')}` : ''),
  );
  check(
    state.roles.join(',') === manifest.roles.join(','),
    `rôles identiques (${state.roles.join(', ')})`,
  );
  check(state.grantsDigest === manifest.grantsDigest, 'droits identiques (empreinte)');
  check(
    state.migrations === manifest.migrations,
    `migrations : ${state.migrations} (sauvegarde : ${manifest.migrations})`,
  );
  check(
    state.audit.events === manifest.audit.events && state.audit.chains === manifest.audit.chains,
    `journal d'audit : ${state.audit.events} événements (sauvegarde : ${manifest.audit.events})`,
  );
  for (const key of ['routers', 'mfa'] as const) {
    check(
      state.secrets[key].total === manifest.secrets[key].total,
      `secrets ${key} : ${state.secrets[key].total} (sauvegarde : ${manifest.secrets[key].total})`,
    );
  }
  return [...lines, ...selfChecks(state)];
}

export function parseManifest(text: string): DatabaseState {
  const value = JSON.parse(text) as DatabaseState;
  if (value.format !== MANIFEST_FORMAT || !Array.isArray(value.tables)) {
    throw new Error('Manifeste de sauvegarde invalide');
  }
  return value;
}

/** Migrations du code déjà toutes appliquées : la base restaurée n'en reçoit aucune. */
export async function checkMigrationsUpToDate(
  migratorUrl: string,
  countMigrations: () => Promise<number>,
  run: (url: string) => Promise<void>,
): Promise<CheckLine> {
  const before = await countMigrations();
  await run(migratorUrl);
  const after = await countMigrations();
  return after === before
    ? { status: 'OK', label: `migrations du code déjà appliquées (${before}), aucune rejouée` }
    : {
        status: 'INFO',
        label: `${after - before} migration(s) appliquée(s) : sauvegarde d'une version antérieure du code`,
      };
}
