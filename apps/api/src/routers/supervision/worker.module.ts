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
import { tunnelWriterFactory } from '../routeros/writer.js';
import { HotspotProvisioner } from '../provisioning/provisioner.js';
import {
  HOTSPOT_PROVISIONER,
  ProvisioningScheduler,
} from '../provisioning/provisioning.scheduler.js';
import { parseTunnelNetwork } from '../tunnel-ip.js';
import { databaseErrorMessage, MonitoringRecorder } from '../../monitoring/recorder.js';
import { RouterSupervisor } from './supervisor.js';
import { safeError, safeErrorMessage } from '../../common/safe-error.js';

export const WORKER_ENV = Symbol('WORKER_ENV');
export const WORKER_PG_POOL = Symbol('WORKER_PG_POOL');
export const ROUTER_SUPERVISOR = Symbol('ROUTER_SUPERVISOR');
export const MONITORING_RECORDER = Symbol('MONITORING_RECORDER');

/** Fréquence de recherche des routeurs dus (chaque routeur reste collecté tous les N s). */
const TICK_MS = 5_000;
/** Purge de l'historique et des alertes résolues anciennes (lot E1) : au démarrage, puis toutes les heures. */
const PURGE_EVERY_MS = 3_600_000;

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
  private lastPurgeAt = 0;

  constructor(
    @Inject(ROUTER_SUPERVISOR) private readonly supervisor: RouterSupervisor,
    @Inject(MONITORING_RECORDER) private readonly recorder: MonitoringRecorder,
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
      .then(async (results) => {
        beat(this.heartbeat, this.logger);
        if (results.length > 0) {
          const online = results.filter((r) => r.status === 'ONLINE').length;
          this.logger.debug(`Cycle : ${results.length} routeur(s) collecté(s), ${online} ONLINE`);
        }
        await this.purgeIfDue();
      })
      .catch((error: unknown) => {
        // Erreur base de données : message seul (aucune donnée de routeur ni secret).
        this.logger.error(`Cycle de supervision en échec : ${safeErrorMessage(error)}`);
      })
      .finally(() => {
        this.running = null;
      });
  }

  /** Purge horaire ; un échec est journalisé (message seul) et retenté l'heure suivante. */
  private async purgeIfDue(): Promise<void> {
    if (Date.now() - this.lastPurgeAt < PURGE_EVERY_MS) return;
    this.lastPurgeAt = Date.now();
    try {
      const purged = await this.recorder.purge();
      if (purged.metrics > 0 || purged.alerts > 0) {
        this.logger.log(
          `Purge : ${purged.metrics} mesure(s) de plus de ${this.env.MONITORING_METRICS_RETENTION_DAYS} j, ${purged.alerts} alerte(s) résolue(s) de plus de ${this.env.MONITORING_ALERTS_RETENTION_DAYS} j`,
        );
      }
    } catch (error) {
      this.logger.error(`Purge de l'historique en échec : ${databaseErrorMessage(error)}`);
    }
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
            serializers: { err: safeError },
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
          provide: MONITORING_RECORDER,
          inject: [WORKER_PG_POOL],
          useFactory: (pool: pg.Pool) =>
            new MonitoringRecorder(drizzle(pool, { schema, casing: 'snake_case' }), {
              metricsRetentionDays: env.MONITORING_METRICS_RETENTION_DAYS,
              alertsRetentionDays: env.MONITORING_ALERTS_RETENTION_DAYS,
              thresholds: {
                cpuHighPercent: env.MONITORING_CPU_HIGH_PERCENT,
                memoryHighPercent: env.MONITORING_MEMORY_HIGH_PERCENT,
                hysteresisPercent: 10,
                sustainSamples: env.MONITORING_SUSTAIN_SAMPLES,
                degradedMinFailures: env.MONITORING_DEGRADED_MIN_FAILURES,
              },
            }),
        },
        {
          provide: ROUTER_SUPERVISOR,
          inject: [WORKER_PG_POOL, MONITORING_RECORDER],
          useFactory: (pool: pg.Pool, recorder: MonitoringRecorder) => {
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
              () => new Date(),
              recorder,
            );
          },
        },
        {
          // Lot B : réconciliation Hotspot (compte ecsi-cfg) et entretien RADIUS.
          provide: HOTSPOT_PROVISIONER,
          inject: [WORKER_PG_POOL],
          useFactory: (pool: pg.Pool) => {
            const network = parseTunnelNetwork(env.ROUTER_TUNNEL_CIDR, env.ROUTER_TUNNEL_GATEWAY);
            const logger = new Logger('Provisionnement');
            const db = drizzle(pool, { schema, casing: 'snake_case' });
            const provisioner = new HotspotProvisioner(
              db,
              createSecretBox(env),
              tunnelWriterFactory(network),
              network,
              env.RADIUS_NAS_KEY ?? '',
              undefined,
              {
                log: (m) => {
                  logger.log(m);
                },
                warn: (m) => {
                  logger.warn(m);
                },
              },
            );
            return {
              enabled: Boolean(env.RADIUS_NAS_KEY),
              runCycle: () => provisioner.runCycle(),
              housekeeping: () => provisioner.housekeeping(),
            };
          },
        },
        SupervisionScheduler,
        ProvisioningScheduler,
        WorkerPoolCloser,
      ],
    };
  }
}
