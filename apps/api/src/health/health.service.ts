import { Inject, Injectable } from '@nestjs/common';
import type { HealthResponse, HealthStatus } from '@ecsi/shared';
import type { Redis } from 'ioredis';
import type pg from 'pg';
import { ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';
import { PG_POOL } from '../database/database.module.js';
import { REDIS } from '../redis/redis.module.js';
import { StorageService } from '../storage/storage.module.js';

type Check = HealthResponse['checks'][string];

const CHECK_TIMEOUT_MS = 2_000;

async function timed(probe: () => Promise<unknown>): Promise<Check> {
  const started = performance.now();
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      probe(),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error('délai dépassé'));
        }, CHECK_TIMEOUT_MS);
      }),
    ]);
    return { status: 'ok', latencyMs: Math.round(performance.now() - started) };
  } catch (error) {
    // Message court, sans détail de connexion (pas d'hôte ni d'identifiant).
    return { status: 'down', error: error instanceof Error ? error.name : 'Error' };
  } finally {
    clearTimeout(timer);
  }
}

@Injectable()
export class HealthService {
  private readonly startedAt = Date.now();

  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(PG_POOL) private readonly pool: pg.Pool,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(StorageService) private readonly storage: StorageService,
  ) {}

  async check(): Promise<HealthResponse> {
    const [database, redis, storage] = await Promise.all([
      timed(() => this.pool.query('select 1')),
      timed(() => this.redis.ping()),
      timed(() => this.storage.ping()),
    ]);

    // PostgreSQL et Redis sont indispensables ; le stockage objet dégrade le service sans l'arrêter.
    let status: HealthStatus = 'ok';
    if (database.status !== 'ok' || redis.status !== 'ok') status = 'down';
    else if (storage.status !== 'ok') status = 'degraded';

    return {
      status,
      service: 'ecsi-api',
      version: this.env.APP_VERSION,
      uptimeSeconds: Math.round((Date.now() - this.startedAt) / 1000),
      checks: { database, redis, storage },
    };
  }
}
