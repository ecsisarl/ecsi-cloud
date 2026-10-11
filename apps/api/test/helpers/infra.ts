/**
 * Démarre de vrais services (PostgreSQL, Redis, S3) dans des conteneurs pour les tests
 * d'intégration. PostgreSQL est initialisé avec le MÊME script de rôles que docker-compose
 * (infra/postgres/init), afin de tester les privilèges réels.
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

export const TEST_PASSWORDS = {
  superuser: 'test-superuser-password',
  migrator: 'test-migrator-password',
  app: 'test-app-password',
  auth: 'test-auth-password',
  worker: 'test-worker-password',
};

export const S3_TEST_CREDENTIALS = {
  accessKeyId: 'ecsi-test',
  secretAccessKey: 'ecsi-test-secret',
};

export interface TestInfra {
  postgres: StartedPostgreSqlContainer;
  redis: StartedTestContainer;
  s3: StartedTestContainer;
  urls: {
    app: string;
    auth: string;
    worker: string;
    migrator: string;
    superuser: string;
    redis: string;
    s3: string;
  };
  stop(): Promise<void>;
}

/**
 * PostgreSQL 18 seul, initialisé par le script de rôles de docker-compose (une base vide
 * neuve : sert aussi de cible de restauration, test/backup-restore.int.test.ts).
 */
export function startPostgres(): Promise<StartedPostgreSqlContainer> {
  return new PostgreSqlContainer('postgres:18-alpine')
    .withDatabase('ecsi')
    .withUsername('postgres')
    .withPassword(TEST_PASSWORDS.superuser)
    .withEnvironment({
      ECSI_DB_MIGRATOR_PASSWORD: TEST_PASSWORDS.migrator,
      ECSI_DB_APP_PASSWORD: TEST_PASSWORDS.app,
      ECSI_DB_AUTH_PASSWORD: TEST_PASSWORDS.auth,
      ECSI_DB_WORKER_PASSWORD: TEST_PASSWORDS.worker,
    })
    .withCopyFilesToContainer([
      {
        source: resolve(repoRoot, 'infra/postgres/init/01-roles.sh'),
        target: '/docker-entrypoint-initdb.d/01-roles.sh',
        mode: 0o755,
      },
    ])
    .start();
}

export async function startInfra(): Promise<TestInfra> {
  const [postgres, redis, s3] = await Promise.all([
    startPostgres(),
    new GenericContainer('redis:8-alpine').withExposedPorts(6379).start(),
    new GenericContainer('chrislusf/seaweedfs:4.48')
      .withEntrypoint(['/bin/sh', '-c'])
      .withCommand([
        `printf '{"identities":[{"name":"ecsi","credentials":[{"accessKey":"${S3_TEST_CREDENTIALS.accessKeyId}","secretKey":"${S3_TEST_CREDENTIALS.secretAccessKey}"}],"actions":["Admin","Read","Write","List","Tagging"]}]}' > /tmp/s3.json && exec weed server -dir=/data -s3 -s3.port=8333 -s3.config=/tmp/s3.json -volume.max=10 -master.volumeSizeLimitMB=64`,
      ])
      .withExposedPorts(8333)
      .withWaitStrategy(Wait.forHttp('/', 8333).forStatusCodeMatching((code) => code === 403))
      .start(),
  ]);

  const host = postgres.getHost();
  const port = postgres.getPort();
  const url = (user: string, password: string) =>
    `postgres://${user}:${password}@${host}:${port}/ecsi`;

  return {
    postgres,
    redis,
    s3,
    urls: {
      app: url('ecsi_app', TEST_PASSWORDS.app),
      auth: url('ecsi_auth', TEST_PASSWORDS.auth),
      worker: url('ecsi_worker', TEST_PASSWORDS.worker),
      migrator: url('ecsi_migrator', TEST_PASSWORDS.migrator),
      superuser: url('postgres', TEST_PASSWORDS.superuser),
      redis: `redis://${redis.getHost()}:${redis.getMappedPort(6379)}`,
      s3: `http://${s3.getHost()}:${s3.getMappedPort(8333)}`,
    },
    async stop() {
      await Promise.all([postgres.stop(), redis.stop(), s3.stop()]);
    },
  };
}
