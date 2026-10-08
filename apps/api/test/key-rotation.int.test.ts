/**
 * Rotation de la clé de chiffrement (Sprint S3H, étape H2) sur PostgreSQL 18 réel, rôles réels :
 * mots de passe RouterOS (routeurs actifs, supprimé, en cours d'enrôlement) et secrets 2FA
 * sous « k2 », rotation vers « k3 » avec k2 en clé précédente, contrôle --verify (clé active
 * seule), simulation, idempotence, enregistrement illisible, écriture concurrente, repli
 * ecsi_worker et retour arrière. Mêmes fonctions que la commande keys:rotate.
 */
import { randomBytes } from 'node:crypto';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SecretBox } from '../src/auth/crypto/secret-box.js';
import { rotateEncryptionKeys } from '../src/auth/key-rotation.js';
import { verifyEncryptionKeys } from '../src/auth/key-verification.js';
import { runMigrations } from '../src/database/migrate.js';
import { type SeedResult, seedDevData } from '../src/database/seed.js';
import {
  decryptRouterPassword,
  encryptRouterPassword,
  rotateRouterSecrets,
} from '../src/routers/router-secret.js';
import { SEED_PASSWORD } from './helpers/app.js';
import { startInfra, type TestInfra } from './helpers/infra.js';

const K2 = { id: 'k2', base64: randomBytes(32).toString('base64') };
const K3 = { id: 'k3', base64: randomBytes(32).toString('base64') };
const boxK2 = new SecretBox(K2.base64, { id: 'k2' });
const rotating = new SecretBox(K3.base64, { id: 'k3', previous: [K2] });
const k3Only = new SecretBox(K3.base64, { id: 'k3' });
const keysK3 = { active: K3, previous: [K2] };

let infra: TestInfra;
let seed: SeedResult;
let owner: pg.Pool;
let worker: pg.Pool;
let auth: pg.Pool;
/** Mots de passe d'origine (en mémoire du test seulement), par identifiant de routeur. */
const passwords = new Map<string, string>();
const mfaSecrets = new Map<string, string>();
let deletedRouter = '';

const ownerDb = () => drizzle(owner, { casing: 'snake_case' });
const authDb = () => drizzle(auth, { casing: 'snake_case' });

async function addRouter(company: 'A' | 'B', ip: string, opts: { deleted?: boolean } = {}) {
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
    [encryptRouterPassword(boxK2, { companyId, routerId }, password), routerId, !!opts.deleted],
  );
  return routerId;
}

async function storedRouters() {
  return (
    await owner.query<{ id: string; company_id: string; payload: string | null }>(
      'select id, company_id, routeros_password_encrypted as payload from routers order by id',
    )
  ).rows;
}

async function snapshot() {
  const r = await owner.query<{ s: string }>(
    `select coalesce(string_agg(coalesce(routeros_password_encrypted, '-'), ',' order by id), '') ||
            '|' || (select string_agg(secret_enc, ',' order by id) from mfa_factors) as s
       from routers`,
  );
  return r.rows[0]?.s ?? '';
}

beforeAll(async () => {
  infra = await startInfra();
  await runMigrations(infra.urls.migrator);
  owner = new pg.Pool({ connectionString: infra.urls.migrator, max: 2 });
  worker = new pg.Pool({ connectionString: infra.urls.worker, max: 2 });
  auth = new pg.Pool({ connectionString: infra.urls.auth, max: 2 });
  seed = await seedDevData(ownerDb(), SEED_PASSWORD);

  await addRouter('A', '10.200.0.2');
  await addRouter('A', '10.200.0.3');
  await addRouter('B', '10.200.0.4');
  deletedRouter = await addRouter('B', '10.200.0.5', { deleted: true });
  // Routeur en cours d'enrôlement : pas de mot de passe.
  await owner.query(
    `insert into routers (company_id, site_id, name, tunnel_ip, status, transport)
     values ($1, $2, 'enrôlement', '10.200.0.6', 'PROVISIONING', 'API')`,
    [seed.companies.A, seed.sites.A['SITE-A']],
  );
  const principals: [string, string][] = [
    [`mfa:user:${seed.users['admin.a@ecsi.test']}`, 'user_id'],
    [`mfa:user:${seed.users['admin.b@ecsi.test']}`, 'user_id'],
    [`mfa:platform:${seed.platformAdminId}`, 'platform_admin_id'],
  ];
  for (const [aad, column] of principals) {
    const secret = randomBytes(20).toString('hex');
    mfaSecrets.set(aad, secret);
    await owner.query(`insert into mfa_factors (${column}, secret_enc) values ($1, $2)`, [
      aad.split(':')[2],
      boxK2.encrypt(secret, aad),
    ]);
  }
  await owner.query(
    'insert into mfa_recovery_codes (user_id, code_hash) values ($1, $2), ($1, $3)',
    [seed.users['admin.a@ecsi.test'], boxK2.mac('CODE-1'), boxK2.mac('CODE-2')],
  );
}, 180_000);

afterAll(async () => {
  await owner.end();
  await worker.end();
  await auth.end();
  await infra.stop();
});

describe('contrôle --verify (lecture seule)', () => {
  it('avant rotation, sous k2 : tout est déchiffré avec k2 seule', async () => {
    const before = await snapshot();
    const report = await verifyEncryptionKeys(owner, { active: K2, previous: [] });
    expect(report.routers).toEqual({
      total: 4,
      byKey: { k2: 4 },
      activeOk: 4,
      previousOk: 0,
      unreadable: 0,
    });
    expect(report.mfa).toMatchObject({ total: 3, activeOk: 3, unreadable: 0 });
    expect(report.previousKeysRetirable).toBe(true);
    expect(await snapshot()).toBe(before);
  });

  it('nouvelle clé k3 active, k2 en précédente : tout lisible, k2 NON retirable', async () => {
    const report = await verifyEncryptionKeys(owner, keysK3);
    expect(report.routers).toMatchObject({ activeOk: 0, previousOk: 4, unreadable: 0 });
    expect(report.mfa).toMatchObject({ activeOk: 0, previousOk: 3, unreadable: 0 });
    expect(report.recoveryCodesByKey).toEqual({ k2: 2 });
    expect(report.previousKeysRetirable).toBe(false);
  });

  it('k3 seule, sans k2 : tout est illisible (c’est pourquoi k2 reste disponible)', async () => {
    const report = await verifyEncryptionKeys(owner, { active: K3, previous: [] });
    expect(report.routers.unreadable).toBe(4);
    expect(report.mfa.unreadable).toBe(3);
  });
});

describe('rotation k2 → k3', () => {
  it('simulation : contrôle chaque secret, n’écrit rien', async () => {
    const before = await snapshot();
    const routers = await rotateRouterSecrets(ownerDb(), rotating, { dryRun: true });
    const mfa = await rotateEncryptionKeys(authDb(), rotating, { dryRun: true });
    expect(routers).toEqual({ total: 5, rewrapped: 4, failed: 0, skipped: 0 });
    expect(mfa).toMatchObject({ total: 3, rewrapped: 3, failed: 0, skipped: 0 });
    expect(await snapshot()).toBe(before);
  });

  it('repli ecsi_worker : routeurs actifs seulement, le routeur supprimé reste sous k2', async () => {
    const report = await rotateRouterSecrets(drizzle(worker, { casing: 'snake_case' }), rotating);
    expect(report).toEqual({ total: 3, rewrapped: 3, failed: 0, skipped: 0 });
    const verify = await verifyEncryptionKeys(owner, keysK3);
    expect(verify.routers).toMatchObject({ byKey: { k2: 1, k3: 3 }, previousOk: 1 });
    expect(verify.previousKeysRetirable).toBe(false);
  });

  it('propriétaire des tables : tous les routeurs, y compris supprimé ; 2FA par ecsi_auth', async () => {
    const routers = await rotateRouterSecrets(ownerDb(), rotating);
    const mfa = await rotateEncryptionKeys(authDb(), rotating);
    expect(routers).toEqual({ total: 5, rewrapped: 1, failed: 0, skipped: 0 });
    expect(mfa).toMatchObject({ total: 3, rewrapped: 3, failed: 0, skipped: 0 });

    for (const row of await storedRouters()) {
      if (row.payload === null) continue;
      expect(row.payload).toMatch(/^v2:k3:/);
      expect(
        decryptRouterPassword(k3Only, { companyId: row.company_id, routerId: row.id }, row.payload),
      ).toBe(passwords.get(row.id));
    }
    const factors = await owner.query<{ user_id: string | null; pa: string | null; s: string }>(
      'select user_id, platform_admin_id as pa, secret_enc as s from mfa_factors',
    );
    for (const f of factors.rows) {
      const aad = f.user_id ? `mfa:user:${f.user_id}` : `mfa:platform:${f.pa ?? ''}`;
      expect(k3Only.decrypt(f.s, aad)).toBe(mfaSecrets.get(aad));
    }
  });

  it('après rotation : tout sous k3 lisible avec k3 seule ; k2 bloquée par les codes de récupération', async () => {
    const report = await verifyEncryptionKeys(owner, keysK3);
    expect(report.routers).toEqual({
      total: 4,
      byKey: { k3: 4 },
      activeOk: 4,
      previousOk: 0,
      unreadable: 0,
    });
    expect(report.mfa).toMatchObject({ activeOk: 3, previousOk: 0, unreadable: 0 });
    expect(report.recoveryCodesByKey).toEqual({ k2: 2 });
    expect(report.previousKeysRetirable).toBe(false);
    // Codes régénérés par l'utilisateur (sous la clé active) : k2 devient retirable.
    await owner.query('delete from mfa_recovery_codes');
    await owner.query('insert into mfa_recovery_codes (user_id, code_hash) values ($1, $2)', [
      seed.users['admin.a@ecsi.test'],
      rotating.mac('CODE-3'),
    ]);
    const after = await verifyEncryptionKeys(owner, keysK3);
    expect(after.previousKeysRetirable).toBe(true);
    // Contrôle sans k2 dans l'environnement (étape 8 de la procédure) : 0 illisible.
    const withoutK2 = await verifyEncryptionKeys(owner, { active: K3, previous: [] });
    expect(withoutK2.routers.unreadable + withoutK2.mfa.unreadable).toBe(0);
  });

  it('idempotente : une deuxième exécution ne change rien', async () => {
    const before = await snapshot();
    expect(await rotateRouterSecrets(ownerDb(), rotating)).toMatchObject({ rewrapped: 0 });
    expect(await rotateEncryptionKeys(authDb(), rotating)).toMatchObject({ rewrapped: 0 });
    expect(await snapshot()).toBe(before);
  });
});

describe('retour arrière et incidents', () => {
  it('retour arrière avant retrait : k2 de nouveau active, k3 en précédente, sans perte', async () => {
    const back = new SecretBox(K2.base64, { id: 'k2', previous: [K3] });
    expect(await rotateRouterSecrets(ownerDb(), back)).toMatchObject({ rewrapped: 4, failed: 0 });
    expect(await rotateEncryptionKeys(authDb(), back)).toMatchObject({ rewrapped: 3, failed: 0 });
    const report = await verifyEncryptionKeys(owner, { active: K2, previous: [] });
    expect(report.routers).toMatchObject({ activeOk: 4, unreadable: 0 });
    expect(report.mfa).toMatchObject({ activeOk: 3, unreadable: 0 });
  });

  it('identifiant illisible : compté en échec, jamais réécrit, les autres sont traités', async () => {
    // Chiffré d'un autre routeur recopié (données associées différentes) : indéchiffrable.
    const rows = (await storedRouters()).filter((r) => r.payload !== null);
    const [source, target] = rows;
    await owner.query('update routers set routeros_password_encrypted = $1 where id = $2', [
      source?.payload,
      target?.id,
    ]);
    const errors: string[] = [];
    const report = await rotateRouterSecrets(ownerDb(), rotating, {
      onError: (id) => errors.push(id),
    });
    expect(report).toMatchObject({ rewrapped: 3, failed: 1 });
    expect(errors).toEqual([target?.id]);
    const stored = (await storedRouters()).find((r) => r.id === target?.id);
    expect(stored?.payload).toBe(source?.payload); // inchangé
    const verify = await verifyEncryptionKeys(owner, keysK3);
    expect(verify.routers.unreadable).toBe(1);
    expect(verify.previousKeysRetirable).toBe(false);
    // Réparation pour la suite : nouveau mot de passe enregistré sous la clé active.
    await owner.query('update routers set routeros_password_encrypted = $1 where id = $2', [
      encryptRouterPassword(
        rotating,
        { companyId: target?.company_id ?? '', routerId: target?.id ?? '' },
        passwords.get(target?.id ?? '') ?? '',
      ),
      target?.id,
    ]);
  });

  it('écriture concurrente (activation, nouveaux identifiants) : jamais écrasée par la rotation', async () => {
    // Remet tout sous k2 pour rejouer une rotation.
    const back = new SecretBox(K2.base64, { id: 'k2', previous: [K3] });
    await rotateRouterSecrets(ownerDb(), back);
    const target = (await storedRouters()).find(
      (r) => r.payload !== null && r.id !== deletedRouter,
    );
    const fresh = encryptRouterPassword(
      rotating,
      { companyId: target?.company_id ?? '', routerId: target?.id ?? '' },
      'NOUVEAU-MOT-DE-PASSE',
    );
    const report = await rotateRouterSecrets(ownerDb(), rotating, {
      beforeWrite: async (id) => {
        if (id === target?.id) {
          await owner.query('update routers set routeros_password_encrypted = $1 where id = $2', [
            fresh,
            id,
          ]);
        }
      },
    });
    expect(report).toMatchObject({ rewrapped: 3, skipped: 1, failed: 0 });
    const stored = (await storedRouters()).find((r) => r.id === target?.id);
    expect(stored?.payload).toBe(fresh);
    expect(
      decryptRouterPassword(
        k3Only,
        { companyId: target?.company_id ?? '', routerId: target?.id ?? '' },
        stored?.payload ?? '',
      ),
    ).toBe('NOUVEAU-MOT-DE-PASSE');
  });
});
