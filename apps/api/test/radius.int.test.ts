/**
 * Lot B — FreeRADIUS RÉEL (image infra/radius, configuration de production) branché sur
 * PostgreSQL 18 réel avec les rôles réels (ecsi_radius : EXECUTE sur radius.* seulement).
 * Le NAS est SIMULÉ par radclient (outil officiel FreeRADIUS) lancé depuis un second
 * conteneur, dont l'adresse joue le rôle de l'adresse tunnel d'un routeur : HTTP-CHAP,
 * attributs MikroTik de réponse, accounting tamponné sur disque puis rejoué, refus (code
 * inconnu, ticket désactivé, expiré, épuisé, autre site, PAP, mauvais secret, NAS inconnu)
 * et absence du code dans la base, le tampon d'accounting et les journaux.
 */
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import {
  GenericContainer,
  Network,
  type StartedNetwork,
  type StartedTestContainer,
  Wait,
} from 'testcontainers';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../src/database/migrate.js';
import { seedDevData } from '../src/database/seed.js';
import { deriveVoucherCode, nasSecret, voucherLookup } from '../src/hotspot/radius-keys.js';
import { SEED_PASSWORD } from './helpers/app.js';
import { TEST_PASSWORDS } from './helpers/infra.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const RADIUS_IMAGE = 'ecsi-cloud/radius:test';

// Clés générées à l'exécution (jamais dans le dépôt).
const LOOKUP_KEY = randomBytes(32).toString('hex');
const NAS_KEY = randomBytes(32).toString('hex');
const CODE_KEY = randomBytes(32).toString('hex');

let network: StartedNetwork;
let postgres: StartedPostgreSqlContainer;
let radius: StartedTestContainer;
let nas: StartedTestContainer;
let otherNas: StartedTestContainer;
let migrator: pg.Pool;
let nasIp: string;
let companyA: string;
let siteA: string;
let siteB: string;
let routerA: string;
let routerOtherSite: string;
let otherNasIp: string;
const codes = new Map<string, string>();

async function q<T extends pg.QueryResultRow>(text: string, values: unknown[] = []) {
  return (await migrator.query<T>(text, values)).rows;
}

/** Envoie un paquet avec radclient depuis le conteneur « NAS ». */
async function radclient(
  attrs: string,
  kind: 'auth' | 'acct' = 'auth',
  secret = nasSecret(NAS_KEY, routerA, 1),
  from: StartedTestContainer = nas,
): Promise<{ code: number; out: string }> {
  const port = kind === 'auth' ? 1812 : 1813;
  const result = await from.exec(
    [
      'sh',
      '-c',
      `printf '%s\\n' "$ATTRS" | /usr/bin/radclient -x -r 1 -t 3 radius:${port} ${kind} "$SECRET"`,
    ],
    { env: { ATTRS: attrs, SECRET: secret } },
  );
  return { code: result.exitCode, out: result.output };
}

const accessRequest = (user: string, password: string, mac = 'AA:BB:CC:00:00:01') =>
  `User-Name = "${user}", CHAP-Password = "${password}", Calling-Station-Id = "${mac}", NAS-Port-Type = Wireless-802.11, Message-Authenticator = 0x00`;

async function insertVoucher(
  key: string,
  overrides: Partial<Record<'site' | 'state' | 'validity' | 'session' | 'quota', unknown>> = {},
) {
  const [batch] = await q<{ id: string }>(
    `insert into voucher_batches (company_id, plan_id, site_id, quantity)
     select company_id, id, $2, 1 from plans where company_id = $1 limit 1 returning id`,
    [companyA, overrides.site ?? siteA],
  );
  const [{ id }] = (await q<{ id: string }>('select uuidv7() as id')) as [{ id: string }];
  const code = deriveVoucherCode(CODE_KEY, id);
  codes.set(key, code);
  await q(
    `insert into vouchers (id, company_id, batch_id, plan_id, site_id, serial, code_lookup,
       price_minor, currency, validity_seconds, session_time_seconds, rate_up_kbps,
       rate_down_kbps, data_quota_bytes, max_devices, idle_timeout_seconds, state,
       disabled_at)
     select $1, $2, $3, p.id, $4, 1, $5, p.price_minor, p.currency, $6, $7, 512, 2048, $8, 1,
            300, $9, case when $9 = 'DISABLED' then now() end
       from plans p where p.company_id = $2 limit 1`,
    [
      id,
      companyA,
      batch?.id,
      overrides.site ?? siteA,
      voucherLookup(LOOKUP_KEY, code),
      overrides.validity ?? 86_400,
      overrides.session ?? 3_600,
      overrides.quota ?? 6_000_000_000,
      overrides.state ?? 'AVAILABLE',
    ],
  );
  return { id, code };
}

beforeAll(async () => {
  network = await new Network().start();
  postgres = await new PostgreSqlContainer('postgres:18-alpine')
    .withNetwork(network)
    .withNetworkAliases('postgres')
    .withDatabase('ecsi')
    .withUsername('postgres')
    .withPassword(TEST_PASSWORDS.superuser)
    .withEnvironment({
      ECSI_DB_MIGRATOR_PASSWORD: TEST_PASSWORDS.migrator,
      ECSI_DB_APP_PASSWORD: TEST_PASSWORDS.app,
      ECSI_DB_AUTH_PASSWORD: TEST_PASSWORDS.auth,
      ECSI_DB_WORKER_PASSWORD: TEST_PASSWORDS.worker,
      ECSI_DB_RADIUS_PASSWORD: TEST_PASSWORDS.radius,
    })
    .withCopyFilesToContainer([
      {
        source: resolve(repoRoot, 'infra/postgres/init/01-roles.sh'),
        target: '/docker-entrypoint-initdb.d/01-roles.sh',
        mode: 0o755,
      },
    ])
    .start();
  const migratorUrl = `postgres://ecsi_migrator:${TEST_PASSWORDS.migrator}@${postgres.getHost()}:${postgres.getPort()}/ecsi`;
  await runMigrations(migratorUrl);
  migrator = new pg.Pool({ connectionString: migratorUrl });
  const seed = await seedDevData(drizzle(migrator, { casing: 'snake_case' }), SEED_PASSWORD);
  companyA = seed.companies.A;
  siteA = seed.sites.A['SITE-A'] ?? '';
  siteB = seed.sites.A['SITE-B'] ?? '';

  // Conteneurs « NAS » : radclient de l'image FreeRADIUS, adresse = adresse tunnel simulée.
  const nasContainer = () =>
    new GenericContainer(RADIUS_IMAGE)
      .withNetwork(network)
      .withEntrypoint(['sleep', 'infinity'])
      .start();
  await GenericContainer.fromDockerfile(resolve(repoRoot, 'infra/radius')).build(RADIUS_IMAGE, {
    deleteOnExit: false,
  });
  [nas, otherNas] = await Promise.all([nasContainer(), nasContainer()]);
  nasIp = nas.getIpAddress(network.getName());
  otherNasIp = otherNas.getIpAddress(network.getName());

  await q(
    `insert into plans (company_id, name, price_minor, currency, validity_seconds)
           values ($1, 'Journée', 50000, 'XOF', 86400)`,
    [companyA],
  );
  const insertRouter = async (ip: string, site: string, name: string) => {
    const [row] = await q<{ id: string }>(
      `insert into routers (company_id, site_id, name, tunnel_ip, status, transport, routeros_username,
         routeros_password_encrypted)
       values ($1, $2, $3, $4, 'ONLINE', 'API', 'ecsi-svc', 'v2:non-utilise-par-ce-test') returning id`,
      [companyA, site, name, ip],
    );
    await q(
      `insert into hotspots (company_id, site_id, router_id, name, interface, gateway_address,
         pool_start, pool_end)
       values ($1, $2, $3, 'HS', 'ether2', '10.5.50.1/24', '10.5.50.10', '10.5.50.200')`,
      [companyA, site, row?.id],
    );
    return row?.id ?? '';
  };
  routerA = await insertRouter(nasIp, siteA, 'CHR-A');
  routerOtherSite = await insertRouter(otherNasIp, siteB, 'CHR-B');

  radius = await new GenericContainer(RADIUS_IMAGE)
    .withNetwork(network)
    .withNetworkAliases('radius')
    .withEnvironment({
      RADIUS_LISTEN_ADDRESS: '0.0.0.0',
      RADIUS_CLIENT_CIDR: '0.0.0.0/0',
      RADIUS_DB_HOST: 'postgres',
      RADIUS_DB_PORT: '5432',
      RADIUS_DB_NAME: 'ecsi',
      RADIUS_DB_PASSWORD: TEST_PASSWORDS.radius,
      RADIUS_VOUCHER_LOOKUP_KEY: LOOKUP_KEY,
      RADIUS_NAS_KEY: NAS_KEY,
    })
    .withTmpFs({ '/run/radiusd': 'rw,size=8m' })
    .withCommand(process.env.RADIUS_DEBUG ? ['debug'] : [])
    .withWaitStrategy(Wait.forLogMessage(/Ready to process requests/))
    .start();
}, 600_000);

afterAll(async () => {
  await migrator.end();
  await Promise.all([radius.stop(), nas.stop(), otherNas.stop(), postgres.stop()]);
  await network.stop();
});

describe('FreeRADIUS réel : authentification HTTP-CHAP', () => {
  it('accepte un ticket valide et renvoie les limites MikroTik', async () => {
    const { id, code } = await insertVoucher('valid');
    const { code: exit, out } = await radclient(accessRequest(code, code));
    expect(exit, out).toBe(0);
    expect(out).toContain('Received Access-Accept');
    expect(out).toMatch(/Session-Timeout = 3600/);
    expect(out).toMatch(/Idle-Timeout = 300/);
    expect(out).toMatch(/Acct-Interim-Interval = 300/);
    expect(out).toMatch(/Mikrotik-Rate-Limit = "512k\/2048k"/);
    expect(out).toMatch(/Mikrotik-Total-Limit = 1705032704/);
    expect(out).toMatch(/Mikrotik-Total-Limit-Gigawords = 1/);
    const [voucher] = await q<{ state: string; activated_at: Date | null; expires_at: Date }>(
      'select state, activated_at, expires_at from vouchers where id = $1',
      [id],
    );
    expect(voucher?.state).toBe('ACTIVE');
    expect(voucher?.activated_at).not.toBeNull();
    expect(voucher?.expires_at.getTime()).toBeGreaterThan(Date.now() + 86_000_000);
  });

  it('accepte le code saisi en majuscules (identifiant et mot de passe identiques)', async () => {
    const { code } = await insertVoucher('upper');
    const typed = code.toUpperCase();
    const { out } = await radclient(accessRequest(typed, typed));
    expect(out).toContain('Received Access-Accept');
  });

  it('refuse un mot de passe différent du code, le PAP, un code inconnu', async () => {
    const code = codes.get('valid') ?? '';
    expect((await radclient(accessRequest(code, `${code}x`))).out).toContain(
      'Received Access-Reject',
    );
    const pap = await radclient(
      `User-Name = "${code}", User-Password = "${code}", Message-Authenticator = 0x00`,
    );
    expect(pap.out).toContain('Received Access-Reject');
    const unknown = await radclient(accessRequest('zzzz2345', 'zzzz2345'));
    expect(unknown.out).toContain('Received Access-Reject');
    expect(unknown.out).toContain('Ticket invalide');
  });

  it('refuse un ticket désactivé, expiré ou épuisé, et hors de son site', async () => {
    const disabled = await insertVoucher('disabled', { state: 'DISABLED' });
    expect((await radclient(accessRequest(disabled.code, disabled.code))).out).toContain(
      'Ticket désactivé',
    );
    const expired = await insertVoucher('expired');
    await q(
      `update vouchers set state = 'ACTIVE', activated_at = now() - interval '2 days',
             expires_at = now() - interval '1 day' where id = $1`,
      [expired.id],
    );
    const out = (await radclient(accessRequest(expired.code, expired.code))).out;
    expect(out).toContain('Received Access-Reject');
    expect(out).toContain('Ticket expiré');
    expect(
      (await q<{ state: string }>('select state from vouchers where id = $1', [expired.id]))[0]
        ?.state,
    ).toBe('EXPIRED');
    const used = await insertVoucher('used', { session: 60 });
    await q('update vouchers set used_seconds = 60 where id = $1', [used.id]);
    expect((await radclient(accessRequest(used.code, used.code))).out).toContain('Forfait épuisé');
    const elsewhere = await insertVoucher('elsewhere', { site: siteB });
    expect((await radclient(accessRequest(elsewhere.code, elsewhere.code))).out).toContain(
      'non valable sur ce site',
    );
    // Le même ticket est valable sur le routeur de son site (SITE-B).
    const ok = await radclient(
      accessRequest(elsewhere.code, elsewhere.code),
      'auth',
      nasSecret(NAS_KEY, routerOtherSite, 1),
      otherNas,
    );
    expect(ok.out).toContain('Received Access-Accept');
  });

  it('ignore un mauvais secret, et refuse tout ticket d’un NAS dont le hotspot est désactivé', async () => {
    const code = codes.get('valid') ?? '';
    const bad = await radclient(accessRequest(code, code), 'auth', randomBytes(20).toString('hex'));
    expect(bad.out).not.toContain('Received Access-Accept');
    expect(bad.out).not.toContain('Received Access-Reject');
    // Client dynamique déjà en cache (lifetime) : la décision SQL refuse quand même.
    await q(`update hotspots set desired_state = 'DISABLED' where router_id = $1`, [routerA]);
    try {
      const out = (await radclient(accessRequest(code, code))).out;
      expect(out).not.toContain('Received Access-Accept');
    } finally {
      await q(`update hotspots set desired_state = 'ENABLED' where router_id = $1`, [routerA]);
    }
  });

  it('limite les appareils simultanés (session ouverte d’un autre appareil)', async () => {
    const { id, code } = await insertVoucher('devices');
    await q(
      `insert into radius_sessions (company_id, site_id, router_id, voucher_id, acct_session_id,
         acct_unique_id, calling_station_id)
       values ($1, $2, $3, $4, 'x1', 'u-devices', 'AA:BB:CC:00:00:09')`,
      [companyA, siteA, routerA, id],
    );
    const other = await radclient(accessRequest(code, code, 'AA:BB:CC:00:00:02'));
    expect(other.out).toContain('déjà utilisé sur un autre appareil');
    const same = await radclient(accessRequest(code, code, 'AA:BB:CC:00:00:09'));
    expect(same.out).toContain('Received Access-Accept');
  });

  it('journalise le résultat sans le code', async () => {
    const rows = await q<Record<string, unknown>>('select * from radius_postauth');
    expect(rows.length).toBeGreaterThan(3);
    expect(rows.some((r) => r.result === 'REJECT' && r.reason === 'UNKNOWN')).toBe(true);
    expect(rows.some((r) => r.result === 'REJECT' && r.reason === 'PAP_REFUSED')).toBe(true);
    const dump = JSON.stringify(rows);
    for (const code of codes.values()) {
      expect(dump.toLowerCase()).not.toContain(code);
    }
  });
});

describe('FreeRADIUS réel : accounting', () => {
  const acct = (status: string, code: string, time: number, input: number, output: number) =>
    `Acct-Status-Type = ${status}, User-Name = "${code}", Acct-Session-Id = "81a00001", Calling-Station-Id = "AA:BB:CC:00:00:01", NAS-Port = 15728641, Framed-IP-Address = 10.5.50.20, Acct-Session-Time = ${time}, Acct-Input-Octets = ${input}, Acct-Output-Octets = ${output}`;

  async function waitFor<T>(
    read: () => Promise<T>,
    ok: (value: T) => boolean,
    attempts = 60,
  ): Promise<T> {
    for (let i = 0; i < attempts; i += 1) {
      const value = await read();
      if (ok(value)) return value;
      await new Promise((r) => setTimeout(r, 500));
    }
    return read();
  }

  it('Start, Interim (rejoué), Stop : session et consommation par écart, sans double compte', async () => {
    const code = codes.get('valid') ?? '';
    const voucherId = (
      await q<{ id: string }>('select id from vouchers where code_lookup = $1', [
        voucherLookup(LOOKUP_KEY, code),
      ])
    )[0]?.id;
    expect((await radclient(acct('Start', code, 0, 0, 0), 'acct')).out).toContain(
      'Accounting-Response',
    );
    await radclient(acct('Interim-Update', code, 300, 1_000_000, 5_000_000), 'acct');
    await radclient(acct('Interim-Update', code, 300, 1_000_000, 5_000_000), 'acct');
    await radclient(acct('Stop', code, 420, 1_500_000, 7_000_000), 'acct');
    const session = await waitFor(
      () =>
        q<Record<string, unknown>>('select * from radius_sessions where voucher_id = $1', [
          voucherId,
        ]),
      (rows) => rows[0]?.stopped_at != null,
    );
    expect(session).toHaveLength(1);
    expect(session[0]).toMatchObject({
      session_seconds: '420',
      input_bytes: '1500000',
      output_bytes: '7000000',
      router_id: routerA,
      calling_station_id: 'AA:BB:CC:00:00:01',
    });
    const [voucher] = await q<{ used_seconds: string; used_bytes: string }>(
      'select used_seconds, used_bytes from vouchers where id = $1',
      [voucherId],
    );
    expect(voucher).toEqual({ used_seconds: '420', used_bytes: '8500000' });
  });

  it('PostgreSQL indisponible : l’accounting est tamponné sur disque puis rejoué', async () => {
    const { id, code } = await insertVoucher('buffered');
    execFileSync('docker', ['pause', postgres.getId()]);
    try {
      const sent = await radclient(
        acct('Start', code, 0, 0, 0).replace('81a00001', '81a00002'),
        'acct',
      );
      expect(sent.out).toContain('Accounting-Response');
    } finally {
      execFileSync('docker', ['unpause', postgres.getId()]);
    }
    const rows = await waitFor(
      () => q('select 1 from radius_sessions where voucher_id = $1', [id]),
      (r) => r.length === 1,
      120,
    );
    expect(rows).toHaveLength(1);
  }, 120_000);

  it('le tampon d’accounting et les journaux ne contiennent aucun code', async () => {
    const spool = await radius.exec([
      'sh',
      '-c',
      'cat /var/spool/radacct/detail-* 2>/dev/null; ls -la /var/spool/radacct',
    ]);
    const text = execFileSync('docker', ['logs', radius.getId()], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    for (const code of codes.values()) {
      expect(spool.output.toLowerCase()).not.toContain(code);
      expect(text.toLowerCase()).not.toContain(code);
    }
    expect(text).not.toContain(LOOKUP_KEY);
    expect(text).not.toContain(NAS_KEY);
  });

  it('le rôle ecsi_radius ne lit aucune table', async () => {
    const url = `postgres://ecsi_radius:${TEST_PASSWORDS.radius}@${postgres.getHost()}:${postgres.getPort()}/ecsi`;
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    try {
      for (const table of ['vouchers', 'routers', 'hotspots', 'radius_sessions', 'users']) {
        await expect(client.query(`select 1 from public.${table} limit 1`)).rejects.toThrow(
          /permission denied/,
        );
      }
      await expect(client.query('select radius.housekeeping()')).rejects.toThrow(
        /permission denied/,
      );
      await expect(client.query("select * from radius.decide('1.1.1.1', 'x', '')")).rejects.toThrow(
        /permission denied/,
      );
    } finally {
      await client.end();
    }
  });
});
