import {
  type DynamicModule,
  Inject,
  Injectable,
  Logger,
  Module,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import pg from 'pg';
import { createSecretBox } from '../../auth/secret-box.provider.js';
import type { GatewayEnv } from '../../config/gateway-env.js';
import { formatIpv4, parseTunnelNetwork } from '../tunnel-ip.js';
import { ActivationServer, type ActivationStore } from './activation-server.js';
import { GatewayPeerSync, type GatewayPeerRow } from './peer-sync.js';
import { execWgClient } from './wg-client.js';

export const GATEWAY_ENV = Symbol('GATEWAY_ENV');
export const GATEWAY_PG_POOL = Symbol('GATEWAY_PG_POOL');

/** Fonctions de la migration 0006 appelées avec le rôle ecsi_worker. */
export function pgActivationStore(pool: pg.Pool): ActivationStore {
  return {
    async target(tunnelIp) {
      const { rows } = await pool.query<{ router_id: string; company_id: string }>(
        'select router_id, company_id from app.router_activation_target($1::inet)',
        [tunnelIp],
      );
      const row = rows[0];
      return row ? { routerId: row.router_id, companyId: row.company_id } : null;
    },
    async activate(input) {
      const { rows } = await pool.query<{ ok: boolean }>(
        'select app.router_activate($1, $2, $3, $4, $5) as ok',
        [
          input.routerId,
          input.companyId,
          input.username,
          input.passwordEncrypted,
          input.tlsFingerprint,
        ],
      );
      return rows[0]?.ok === true;
    },
    async denied(tunnelIp, reason) {
      await pool.query('select app.router_activation_denied($1::inet, $2)', [tunnelIp, reason]);
    },
  };
}

export async function pgGatewayPeers(pool: pg.Pool): Promise<GatewayPeerRow[]> {
  const { rows } = await pool.query<{ public_key: string; tunnel_ip: string; active: boolean }>(
    'select public_key, host(tunnel_ip) as tunnel_ip, active from app.gateway_peers()',
  );
  return rows.map((row) => ({
    publicKey: row.public_key,
    tunnelIp: row.tunnel_ip,
    active: row.active,
  }));
}

/**
 * Agent passerelle : synchronisation des pairs toutes les N s (jamais deux en parallèle) et
 * serveur d'activation sur l'adresse tunnel de la passerelle.
 */
@Injectable()
export class GatewayAgent implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('Passerelle');
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  private readonly sync: GatewayPeerSync;
  private readonly activation: ActivationServer;

  constructor(
    @Inject(GATEWAY_ENV) private readonly env: GatewayEnv,
    @Inject(GATEWAY_PG_POOL) private readonly pool: pg.Pool,
  ) {
    const network = parseTunnelNetwork(env.ROUTER_TUNNEL_CIDR, env.ROUTER_TUNNEL_GATEWAY);
    const log = {
      log: (m: string) => {
        this.logger.log(m);
      },
      warn: (m: string) => {
        this.logger.warn(m);
      },
    };
    this.sync = new GatewayPeerSync(
      () => pgGatewayPeers(pool),
      execWgClient(env.WG_COMMAND, env.WG_INTERFACE),
      network,
      log,
    );
    this.activation = new ActivationServer(
      pgActivationStore(pool),
      createSecretBox(env),
      network,
      log,
    );
  }

  async onApplicationBootstrap(): Promise<void> {
    const network = parseTunnelNetwork(this.env.ROUTER_TUNNEL_CIDR, this.env.ROUTER_TUNNEL_GATEWAY);
    const host = formatIpv4(network.gateway);
    await this.activation.listen(host, this.env.ROUTER_ACTIVATION_PORT);
    this.logger.log(
      `Agent passerelle démarré : interface ${this.env.WG_INTERFACE}, activation sur ${host}:${this.env.ROUTER_ACTIVATION_PORT}, synchronisation toutes les ${this.env.GATEWAY_SYNC_INTERVAL_SECONDS} s`,
    );
    this.timer = setInterval(() => {
      this.tick();
    }, this.env.GATEWAY_SYNC_INTERVAL_SECONDS * 1000);
    this.tick();
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.running;
    await this.activation.close();
    await this.pool.end();
  }

  private tick(): void {
    if (this.running) return;
    this.running = this.sync
      .run()
      .then((report) => {
        if (report.added + report.updated + report.removed > 0) {
          this.logger.log(
            `Pairs WireGuard : ${report.added} ajouté(s), ${report.updated} mis à jour, ${report.removed} retiré(s)`,
          );
        }
      })
      .catch((error: unknown) => {
        this.logger.error(
          `Synchronisation des pairs en échec : ${error instanceof Error ? error.message : String(error)}`,
        );
      })
      .finally(() => {
        this.running = null;
      });
  }
}

@Module({})
export class GatewayModule {
  static forRoot(env: GatewayEnv): DynamicModule {
    return {
      module: GatewayModule,
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
        { provide: GATEWAY_ENV, useValue: env },
        {
          provide: GATEWAY_PG_POOL,
          useFactory: () =>
            new pg.Pool({
              connectionString: env.DATABASE_WORKER_URL,
              max: 2,
              application_name: 'ecsi-gateway',
              statement_timeout: 15_000,
              connectionTimeoutMillis: 5_000,
            }),
        },
        GatewayAgent,
      ],
    };
  }
}
