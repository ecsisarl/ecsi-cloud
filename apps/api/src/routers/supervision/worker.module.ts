import {
  type DynamicModule,
  Inject,
  Injectable,
  Logger,
  Module,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { drizzle } from 'drizzle-orm/node-postgres';
import { LoggerModule } from 'nestjs-pino';
import pg from 'pg';
import { createSecretBox } from '../../auth/secret-box.provider.js';
import { beat, heartbeatPath } from '../../health/heartbeat.js';
import type { WorkerEnv } from '../../config/worker-env.js';
import * as schema from '../../database/schema/index.js';
import { tunnelTransportFactory } from '../routeros/factory.js';
import { parseTunnelNetwork } from '../tunnel-ip.js';
import { RouterSupervisor } from './supervisor.js';

export const WORKER_ENV = Symbol('WORKER_ENV');
export const WORKER_PG_POOL = Symbol('WORKER_PG_POOL');
export const ROUTER_SUPERVISOR = Symbol('ROUTER_SUPERVISOR');

/** Fréquence de recherche des routeurs dus (chaque routeur reste collecté tous les N s). */
const TICK_MS = 5_000;

/**
 * Boucle de supervision : un cycle toutes les 5 s, jamais deux cycles en parallèle dans un
 * même processus ; arrêt propre (SIGTERM) en attendant la fin du cycle en cours. Chaque cycle
 * réussi écrit le battement de cœur lu par le healthcheck Docker (health/heartbeat.ts).
 */
@Injectable()
export class SupervisionScheduler implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('Supervision');
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  private readonly heartbeat = heartbeatPath('worker');

  constructor(
    @Inject(ROUTER_SUPERVISOR) private readonly supervisor: RouterSupervisor,
    @Inject(WORKER_ENV) private readonly env: WorkerEnv,
  ) {}

  onApplicationBootstrap(): void {
    this.logger.log(
      `Worker démarré : plage tunnel ${this.env.ROUTER_TUNNEL_CIDR}, collecte toutes les ${this.env.ROUTER_POLL_INTERVAL_SECONDS} s, OFFLINE après ${this.env.ROUTER_OFFLINE_AFTER_SECONDS} s et ${this.env.ROUTER_OFFLINE_MIN_FAILURES} échecs`,
    );
    this.timer = setInterval(() => {
      this.tick();
    }, TICK_MS);
    this.tick();
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.running;
  }

  private tick(): void {
    if (this.running) return;
    this.running = this.supervisor
      .runCycle()
      .then((results) => {
        beat(this.heartbeat, this.logger);
        if (results.length > 0) {
          const online = results.filter((r) => r.status === 'ONLINE').length;
          this.logger.debug(`Cycle : ${results.length} routeur(s) collecté(s), ${online} ONLINE`);
        }
      })
      .catch((error: unknown) => {
        // Erreur base de données : message seul (aucune donnée de routeur ni secret).
        this.logger.error(
          `Cycle de supervision en échec : ${error instanceof Error ? error.message : String(error)}`,
        );
      })
      .finally(() => {
        this.running = null;
      });
  }
}

@Injectable()
class WorkerPoolCloser implements OnApplicationShutdown {
  constructor(@Inject(WORKER_PG_POOL) private readonly pool: pg.Pool) {}

  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }
}

/**
 * Application du worker (`src/worker.ts`) : même base de code et mêmes conventions NestJS que
 * l'API, mais un contexte d'application SANS serveur HTTP et sans les modules de l'API.
 */
@Module({})
export class WorkerModule {
  static forRoot(env: WorkerEnv): DynamicModule {
    return {
      module: WorkerModule,
      imports: [
        LoggerModule.forRoot({
          pinoHttp: {
            level: env.LOG_LEVEL,
            ...(env.LOG_PRETTY
              ? { transport: { target: 'pino-pretty', options: { singleLine: true } } }
              : {}),
          },
        }),
      ],
      providers: [
        { provide: WORKER_ENV, useValue: env },
        {
          provide: WORKER_PG_POOL,
          useFactory: () =>
            new pg.Pool({
              connectionString: env.DATABASE_WORKER_URL,
              max: 4,
              application_name: 'ecsi-worker',
              statement_timeout: 15_000,
              connectionTimeoutMillis: 5_000,
            }),
        },
        {
          provide: ROUTER_SUPERVISOR,
          inject: [WORKER_PG_POOL],
          useFactory: (pool: pg.Pool) => {
            const network = parseTunnelNetwork(env.ROUTER_TUNNEL_CIDR, env.ROUTER_TUNNEL_GATEWAY);
            const logger = new Logger('Supervision');
            return new RouterSupervisor(
              drizzle(pool, { schema, casing: 'snake_case' }),
              createSecretBox(env),
              tunnelTransportFactory(network),
              {
                pollIntervalSeconds: env.ROUTER_POLL_INTERVAL_SECONDS,
                batchSize: env.ROUTER_POLL_BATCH_SIZE,
                concurrency: env.ROUTER_POLL_CONCURRENCY,
                thresholds: {
                  offlineAfterSeconds: env.ROUTER_OFFLINE_AFTER_SECONDS,
                  offlineMinFailures: env.ROUTER_OFFLINE_MIN_FAILURES,
                },
              },
              {
                log: (m) => {
                  logger.log(m);
                },
                warn: (m) => {
                  logger.warn(m);
                },
                debug: (m) => {
                  logger.debug(m);
                },
              },
            );
          },
        },
        SupervisionScheduler,
        WorkerPoolCloser,
      ],
    };
  }
}
