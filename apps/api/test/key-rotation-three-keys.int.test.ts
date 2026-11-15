/**
 * Rotation à trois clés (Sprint S3H, étape H3, outillage D.1) sur PostgreSQL 18 réel, rôles
 * réels. Reproduit l'état de production après H2 — secrets sous « k3 », codes de récupération
 * 2FA restés sous « k2 » — puis la rotation k3 → k4 avec k3 et k2 en anciennes clés :
 *  - verdict PAR CLÉ : k4 active, k3 retirable après migration, k2 encore nécessaire pour les
 *    codes de récupération, 0 secret illisible ;
 *  - simulation, idempotence, retour arrière k4 → k3 puis nouvelle rotation ;
 *  - retrait de k3 de l'environnement : tout reste lisible, les codes de récupération restent
 *    utilisables (k2 conservée) ;
 *  - une clé absente de l'environnement dont dépendent des données n'est jamais déclarée
 *    retirable, et bloque le retrait des autres.
 */
import { randomBytes } from 'node:crypto';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type KeyMaterial, SecretBox } from '../src/auth/crypto/secret-box.js';
import { rotateEncryptionKeys } from '../src/auth/key-rotation.js';
import {
  formatKeyVerification,
  keyStatus,
  verifyEncryptionKeys,
} from '../src/auth/key-verification.js';
import { runMigrations } from '../src/database/migrate.js';
import { type SeedResult, seedDevData } from '../src/database/seed.js';
import {
  decryptRouterPassword,
  encryptRouterPassword,
  rotateRouterSecrets,
} from '../src/routers/router-secret.js';
import { SEED_PASSWORD } from './helpers/app.js';
import { startInfra, type TestInfra } from './helpers/infra.js';

const key = (id: string): KeyMaterial => ({ id, base64: randomBytes(32).toString('base64') });
const K2 = key('k2');
const K3 = key('k3');
const K4 = key('k4');
const box = (active: KeyMaterial, previous: KeyMaterial[] = []) =>
  new SecretBox(active.base64, { id: active.id, previous });

/** État de production après H2 : k3 active, k2 ancienne clé. */
const h2 = { active: K3, previous: [K2] };
/** Transition H3.4 : k4 active, k3 et k2 anciennes clés. */
const h3 = { active: K4, previous: [K3, K2] };
/** Après H3.5 : k3 retirée de l'environnement, k2 conservée. */
const h3Retired = { active: K4, previous: [K2] };
/** Retour arrière : k3 de nouveau active. */
const rollback = { active: K3, previous: [K4, K2] };

let infra: TestInfra;
let seed: SeedResult;
let owner: pg.Pool;
let auth: pg.Pool;
const passwords = new Map<string, string>();
const mfaSecrets = new Map<string, string>();
const RECOVERY = ['ABCDE23456', 'FGHJK78923'];

const ownerDb = () => drizzle(owner, { casing: 'snake_case' });
const authDb = () => drizzle(auth, { casing: 'snake_case' });

async function rotate(keys: { active: KeyMaterial; previous: KeyMaterial[] }, dryRun = false) {
  const b = box(keys.active, keys.previous);
  return {
    routers: await rotateRouterSecrets(ownerDb(), b, { dryRun }),
    mfa: await rotateEncryptionKeys(authDb(), b, { dryRun }),
  };
}

async function snapshot() {
  const r = await owner.query<{ s: string }>(
    `select coalesce(string_agg(coalesce(routeros_password_encrypted, '-'), ',' order by id), '') ||
            '|' || (select string_agg(secret_enc, ',' order by id) from mfa_factors) ||
            '|' || (select string_agg(code_hash, ',' order by id) from mfa_recovery_codes) as s
       from routers`,
  );
  return r.rows[0]?.s ?? '';
}

/** Chaque secret se déchiffre avec la SEULE clé indiquée et égale l'original. */
async function expectAllReadableWithOnly(only: KeyMaterial) {
  const single = box(only);
  const rows = await owner.query<{ id: string; company_id: string; p: string | null }>(
    'select id, company_id, routeros_password_encrypted as p from routers',
  );
  for (const row of rows.rows) {
    if (row.p === null) continue;
    expect(row.p.startsWith(`v2:${only.id}:`)).toBe(true);
    expect(
      decryptRouterPassword(single, { companyId: row.company_id, routerId: row.id }, row.p),
    ).toBe(passwords.get(row.id));
  }
  const factors = await owner.query<{ user_id: string | null; pa: string | null; s: string }>(
    'select user_id, platform_admin_id as pa, secret_enc as s from mfa_factors',
  );
  for (const f of factors.rows) {
    const aad = f.user_id ? `mfa:user:${f.user_id}` : `mfa:platform:${f.pa ?? ''}`;
    expect(single.decrypt(f.s, aad)).toBe(mfaSecrets.get(aad));
  }
}

/** Les codes de récupération restent reconnus avec la configuration de clés donnée. */
async function expectRecoveryCodesUsable(keys: { active: KeyMaterial; previous: KeyMaterial[] }) {
  const stored = new Set(
    (await owner.query<{ h: string }>('select code_hash as h from mfa_recovery_codes')).rows.map(
      (r) => r.h,
    ),
  );
  const b = box(keys.active, keys.previous);
  for (const code of RECOVERY) {
    expect(b.macCandidates(code).some((candidate) => stored.has(candidate))).toBe(true);
  }
}

beforeAll(async () => {
  infra = await startInfra();
  await runMigrations(infra.urls.migrator);
  owner = new pg.Pool({ connectionString: infra.urls.migrator, max: 2 });
  auth = new pg.Pool({ connectionString: infra.urls.auth, max: 2 });
  seed = await seedDevData(ownerDb(), SEED_PASSWORD);

  // Données créées sous k2 (avant H2).
  const k2 = box(K2);
  const routersToCreate: [keyof SeedResult['companies'], string, boolean][] = [
    ['A', '10.200.0.2', false],
    ['A', '10.200.0.3', false],
    ['B', '10.200.0.4', false],
    ['B', '10.200.0.5', true],
  ];
  for (const [company, ip, deleted] of routersToCreate) {
    const companyId = seed.companies[company];
    const { rows } = await owner.query<{ id: string }>(
      `insert into routers (company_id, site_id, name, tunnel_ip, routeros_username,
         routeros_password_encrypted, transport)
       values ($1, $2, $3, $4, 'ecsi', 'v2:k2:x', 'API') returning id`,
      [companyId, seed.sites[company]['SITE-A'], `R ${ip}`, ip],
    );
    const routerId = rows[0]?.id ?? '';
    const password = randomBytes(12).toString('hex');
    passwords.set(routerId, password);
    await owner.query(
      `update routers set routeros_password_encrypted = $1,
         deleted_at = case when $3 then now() else null end where id = $2`,
      [encryptRouterPassword(k2, { companyId, routerId }, password), routerId, deleted],
    );
  }
  await owner.query(
    `insert into routers (company_id, site_id, name, tunnel_ip, status, transport)
     values ($1, $2, 'enrôlement', '10.200.0.6', 'PROVISIONING', 'API')`,
    [seed.companies.A, seed.sites.A['SITE-A']],
  );
  for (const [aad, column] of [
    [`mfa:user:${seed.users['admin.a@ecsi.test']}`, 'user_id'],
    [`mfa:platform:${seed.platformAdminId}`, 'platform_admin_id'],
  ] as const) {
    const secret = randomBytes(20).toString('hex');
    mfaSecrets.set(aad, secret);
    await owner.query(`insert into mfa_factors (${column}, secret_enc) values ($1, $2)`, [
      aad.split(':')[2],
      k2.encrypt(secret, aad),
    ]);
  }
  await owner.query(
    'insert into mfa_recovery_codes (user_id, code_hash) values ($1, $2), ($1, $3)',
    [seed.users['admin.a@ecsi.test'], k2.mac(RECOVERY[0] ?? ''), k2.mac(RECOVERY[1] ?? '')],
  );
  // Rotation H2 (k2 → k3) : les secrets passent sous k3, les codes restent sous k2.
  const done = await rotate(h2);
  expect(done.routers.failed + done.mfa.failed).toBe(0);
}, 180_000);

afterAll(async () => {
  await owner.end();
  await auth.end();
  await infra.stop();
});

describe('verdict par clé (D.1)', () => {
  it('état après H2 : k3 active, k2 encore nécessaire pour les codes de récupération', async () => {
    const report = await verifyEncryptionKeys(owner, h2);
    expect(report.keys).toEqual([
      {
        id: 'k3',
        active: true,
        provided: true,
        routers: 4,
        mfa: 2,
        recoveryCodes: 0,
        retirable: false,
      },
      {
        id: 'k2',
        active: false,
        provided: true,
        routers: 0,
        mfa: 0,
        recoveryCodes: 2,
        retirable: false,
      },
    ]);
    expect(report.routers.unreadable + report.mfa.unreadable).toBe(0);
  });

  it('transition k4 + k3 + k2 avant rotation : k3 et k2 nécessaires, 0 illisible', async () => {
    const before = await snapshot();
    const report = await verifyEncryptionKeys(owner, h3);
    expect(keyStatus(report, 'k4')).toMatchObject({ active: true, routers: 0, mfa: 0 });
    expect(keyStatus(report, 'k3')).toMatchObject({ routers: 4, mfa: 2, retirable: false });
    expect(keyStatus(report, 'k2')).toMatchObject({ recoveryCodes: 2, retirable: false });
    expect(report.routers.unreadable + report.mfa.unreadable).toBe(0);
    expect(await snapshot()).toBe(before);
  });

  it('simulation k3 → k4 : chaque secret contrôlé, rien n’est écrit', async () => {
    const before = await snapshot();
    const result = await rotate(h3, true);
    expect(result.routers).toEqual({ total: 5, rewrapped: 4, failed: 0, skipped: 0 });
    expect(result.mfa).toMatchObject({ total: 2, rewrapped: 2, failed: 0, skipped: 0 });
    expect(await snapshot()).toBe(before);
  });

  it('rotation k3 → k4 : k4 active, k3 retirable, k2 encore nécessaire, 0 illisible', async () => {
    const result = await rotate(h3);
    expect(result.routers).toEqual({ total: 5, rewrapped: 4, failed: 0, skipped: 0 });
    expect(result.mfa).toMatchObject({ total: 2, rewrapped: 2, failed: 0, skipped: 0 });

    const report = await verifyEncryptionKeys(owner, h3);
    expect(report.keys).toEqual([
      {
        id: 'k4',
        active: true,
        provided: true,
        routers: 4,
        mfa: 2,
        recoveryCodes: 0,
        retirable: false,
      },
      {
        id: 'k3',
        active: false,
        provided: true,
        routers: 0,
        mfa: 0,
        recoveryCodes: 0,
        retirable: true,
      },
      {
        id: 'k2',
        active: false,
        provided: true,
        routers: 0,
        mfa: 0,
        recoveryCodes: 2,
        retirable: false,
      },
    ]);
    expect(report.routers).toMatchObject({ activeOk: 4, previousOk: 0, unreadable: 0 });
    expect(report.mfa).toMatchObject({ activeOk: 2, previousOk: 0, unreadable: 0 });
    // Le verdict global reste « non » (k2) : seul le verdict par clé autorise le retrait de k3.
    expect(report.previousKeysRetirable).toBe(false);
    await expectAllReadableWithOnly(K4);
    await expectRecoveryCodesUsable(h3);

    const lines = formatKeyVerification(report).join('\n');
    expect(lines).toContain('INFO  clé k4 : active');
    expect(lines).toContain('OK    clé k3 : retirable');
    expect(lines).toContain(
      'INFO  clé k2 : ENCORE NÉCESSAIRE (0 mot(s) de passe RouterOS, 0 secret(s) 2FA, 2 code(s) de récupération) : NE PAS retirer',
    );
    expect(lines).toContain('0 illisible(s)');
    expect(lines).not.toContain(K2.base64);
    expect(lines).not.toContain(K3.base64);
    expect(lines).not.toContain(K4.base64);
  });

  it('idempotence : une deuxième rotation ne change rien', async () => {
    const before = await snapshot();
    const again = await rotate(h3);
    expect(again.routers).toMatchObject({ rewrapped: 0, failed: 0 });
    expect(again.mfa).toMatchObject({ rewrapped: 0, failed: 0 });
    expect(await snapshot()).toBe(before);
  });
});

describe('retour arrière et retrait de k3', () => {
  it('retour arrière k4 → k3 : tout revient sous k3, k4 retirable, k2 nécessaire', async () => {
    const back = await rotate(rollback);
    expect(back.routers).toMatchObject({ rewrapped: 4, failed: 0 });
    expect(back.mfa).toMatchObject({ rewrapped: 2, failed: 0 });
    const report = await verifyEncryptionKeys(owner, rollback);
    expect(keyStatus(report, 'k3')).toMatchObject({ active: true, routers: 4, mfa: 2 });
    expect(keyStatus(report, 'k4').retirable).toBe(true);
    expect(keyStatus(report, 'k2')).toMatchObject({ recoveryCodes: 2, retirable: false });
    expect(report.routers.unreadable + report.mfa.unreadable).toBe(0);
    await expectAllReadableWithOnly(K3);
    await expectRecoveryCodesUsable(rollback);
    // Idempotence du retour arrière.
    const again = await rotate(rollback);
    expect(again.routers.rewrapped + again.mfa.rewrapped).toBe(0);
  });

  it('nouvelle rotation vers k4 après le retour arrière', async () => {
    const result = await rotate(h3);
    expect(result.routers).toMatchObject({ rewrapped: 4, failed: 0 });
    expect(result.mfa).toMatchObject({ rewrapped: 2, failed: 0 });
    expect(keyStatus(await verifyEncryptionKeys(owner, h3), 'k3').retirable).toBe(true);
  });

  it('k3 retirée de l’environnement (k2 conservée) : 0 illisible, codes toujours utilisables', async () => {
    const report = await verifyEncryptionKeys(owner, h3Retired);
    expect(report.knownKeyIds).toEqual(['k4', 'k2']);
    expect(report.routers.unreadable + report.mfa.unreadable).toBe(0);
    expect(keyStatus(report, 'k3')).toMatchObject({ provided: false, retirable: true });
    expect(keyStatus(report, 'k2')).toMatchObject({ recoveryCodes: 2, retirable: false });
    await expectAllReadableWithOnly(K4);
    await expectRecoveryCodesUsable(h3Retired);
  });

  it('sans k2 : les codes de récupération ne seraient plus reconnus (k2 doit rester)', async () => {
    const stored = new Set(
      (await owner.query<{ h: string }>('select code_hash as h from mfa_recovery_codes')).rows.map(
        (r) => r.h,
      ),
    );
    const withoutK2 = box(K4);
    for (const code of RECOVERY) {
      expect(withoutK2.macCandidates(code).some((c) => stored.has(c))).toBe(false);
    }
  });

  it('donnée sous une clé absente de l’environnement : ECHEC, aucune clé déclarée retirable', async () => {
    const [row] = (
      await owner.query<{ id: string; company_id: string; p: string }>(
        `select id, company_id, routeros_password_encrypted as p from routers
          where routeros_password_encrypted is not null order by id limit 1`,
      )
    ).rows;
    if (!row) throw new Error('aucun routeur');
    const k1 = key('k1');
    await owner.query('update routers set routeros_password_encrypted = $1 where id = $2', [
      encryptRouterPassword(box(k1), { companyId: row.company_id, routerId: row.id }, 'x'),
      row.id,
    ]);
    try {
      const report = await verifyEncryptionKeys(owner, h3);
      expect(report.routers.unreadable).toBe(1);
      expect(keyStatus(report, 'k1')).toMatchObject({
        provided: false,
        routers: 1,
        retirable: false,
      });
      expect(keyStatus(report, 'k3').retirable).toBe(false);
      expect(formatKeyVerification(report).join('\n')).toContain(
        'ECHEC clé k1 : ABSENTE de l’environnement',
      );
    } finally {
      await owner.query('update routers set routeros_password_encrypted = $1 where id = $2', [
        row.p,
        row.id,
      ]);
    }
    expect(keyStatus(await verifyEncryptionKeys(owner, h3), 'k3').retirable).toBe(true);
  });
});
