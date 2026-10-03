import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';
import * as schema from './schema/index.js';

/** Rôle ecsi_app : API métier, toujours soumise à la RLS (voir tenancy/tenant-database.ts). */
export const PG_POOL = Symbol('PG_POOL');
export const DRIZZLE = Symbol('DRIZZLE');
/** Rôle ecsi_auth : réservé au module d'authentification (identifiants, sessions, jetons). */
export const AUTH_PG_POOL = Symbol('AUTH_PG_POOL');
export const AUTH_DRIZZLE = Symbol('AUTH_DRIZZLE');

export type Database = NodePgDatabase<typeof schema>;

@Global()
@Module({
  providers: [
    {
      provide: PG_POOL,
      inject: [ENV],
      useFactory: (env: Env) =>
        new pg.Pool({
          connectionString: env.DATABASE_URL,
          max: env.DATABASE_POOL_MAX,
          application_name: 'ecsi-api',
          // Une requête ne doit jamais bloquer indéfiniment un worker HTTP.
          statement_timeout: 15_000,
          connectionTimeoutMillis: 5_000,
        }),
    },
    {
      provide: DRIZZLE,
      inject: [PG_POOL],
      useFactory: (pool: pg.Pool): Database => drizzle(pool, { schema, casing: 'snake_case' }),
    },
    {
      provide: AUTH_PG_POOL,
      inject: [ENV],
      useFactory: (env: Env) =>
        new pg.Pool({
          connectionString: env.DATABASE_AUTH_URL,
          max: Math.max(2, Math.ceil(env.DATABASE_POOL_MAX / 2)),
          application_name: 'ecsi-api-auth',
          statement_timeout: 15_000,
          connectionTimeoutMillis: 5_000,
        }),
    },
    {
      provide: AUTH_DRIZZLE,
      inject: [AUTH_PG_POOL],
      useFactory: (pool: pg.Pool): Database => drizzle(pool, { schema, casing: 'snake_case' }),
    },
  ],
  exports: [PG_POOL, DRIZZLE, AUTH_PG_POOL, AUTH_DRIZZLE],
})
export class DatabaseModule implements OnApplicationShutdown {
  constructor(
    @Inject(PG_POOL) private readonly pool: pg.Pool,
    @Inject(AUTH_PG_POOL) private readonly authPool: pg.Pool,
  ) {}

  async onApplicationShutdown(): Promise<void> {
    await Promise.all([this.pool.end(), this.authPool.end()]);
  }
}
