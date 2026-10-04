import { and, eq, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { SecretBox } from '../../auth/crypto/secret-box.js';
import { routers, type RouterStatus } from '../../database/schema/index.js';
import { decryptRouterPassword } from '../router-secret.js';
import { RouterOsError, sanitizeDetail } from '../routeros/errors.js';
import type { TransportFactory } from '../routeros/factory.js';
import { collectSnapshot, type RouterSnapshot } from './collector.js';
import {
  DEFAULT_THRESHOLDS,
  nextStatus,
  type PollOutcome,
  type StatusThresholds,
} from './status.js';

export interface SupervisorOptions {
  /** Intervalle entre deux collectes d'un même routeur. */
  readonly pollIntervalSeconds: number;
  /** Routeurs réservés par cycle. */
  readonly batchSize: number;
  /** Collectes simultanées. */
  readonly concurrency: number;
  readonly thresholds: StatusThresholds;
}

export const DEFAULT_SUPERVISOR_OPTIONS: SupervisorOptions = {
  pollIntervalSeconds: 60,
  batchSize: 100,
  concurrency: 10,
  thresholds: DEFAULT_THRESHOLDS,
};

/** Journal minimal (Logger NestJS ou équivalent) : jamais de secret transmis. */
export interface SupervisorLogger {
  log(message: string): void;
  warn(message: string): void;
  debug?(message: string): void;
}

export type ClaimedRouter = Awaited<ReturnType<RouterSupervisor['claimDue']>>[number];

export interface PollResult {
  readonly routerId: string;
  readonly status: RouterStatus;
  readonly outcome: PollOutcome;
  readonly error: string | null;
}

/**
 * Supervision périodique des routeurs (rôle PostgreSQL ecsi_worker).
 *
 * Chaque cycle RÉSERVE les routeurs dus (UPDATE … last_sync_at = now() sur une sélection
 * FOR UPDATE SKIP LOCKED) : plusieurs workers peuvent tourner sans collecter deux fois le
 * même routeur ; un worker arrêté en cours de collecte libère ses routeurs au cycle suivant.
 * Pour chaque routeur : déchiffrement du mot de passe (AAD liée au routeur), connexion
 * EXCLUSIVEMENT à son adresse tunnel (re-validée par la fabrique de transport), lecture,
 * puis enregistrement de l'instantané et de l'état. Le mot de passe n'est jamais journalisé
 * ni stocké ailleurs qu'en mémoire le temps de la collecte.
 */
export class RouterSupervisor {
  constructor(
    private readonly db: NodePgDatabase<Record<string, unknown>>,
    private readonly box: SecretBox,
    private readonly transports: TransportFactory,
    private readonly options: SupervisorOptions = DEFAULT_SUPERVISOR_OPTIONS,
    private readonly logger: SupervisorLogger = { log: () => undefined, warn: () => undefined },
    private readonly clock: () => Date = () => new Date(),
  ) {}

  /** Un cycle complet : réserve les routeurs dus et les collecte (concurrence bornée). */
  async runCycle(): Promise<PollResult[]> {
    const claimed = await this.claimDue();
    const results: PollResult[] = [];
    let next = 0;
    const lanes = Array.from(
      { length: Math.min(this.options.concurrency, claimed.length) },
      async () => {
        while (next < claimed.length) {
          const router = claimed[next++];
          if (router) results.push(await this.pollOne(router));
        }
      },
    );
    await Promise.all(lanes);
    return results;
  }

  claimDue() {
    const due = this.db
      .select({ id: routers.id })
      .from(routers)
      .where(
        and(
          isNull(routers.deletedAt),
          or(
            isNull(routers.lastSyncAt),
            lte(
              routers.lastSyncAt,
              sql`now() - make_interval(secs => ${this.options.pollIntervalSeconds})`,
            ),
          ),
        ),
      )
      .orderBy(sql`${routers.lastSyncAt} asc nulls first`)
      .limit(this.options.batchSize)
      .for('update', { skipLocked: true });
    return this.db
      .update(routers)
      .set({ lastSyncAt: sql`now()` })
      .where(inArray(routers.id, due))
      .returning({
        id: routers.id,
        companyId: routers.companyId,
        status: routers.status,
        transport: routers.transport,
        tunnelIp: routers.tunnelIp,
        tlsFingerprint: routers.tlsFingerprint,
        username: routers.routerosUsername,
        secret: routers.routerosPasswordEncrypted,
        consecutiveFailures: routers.consecutiveFailures,
        lastSeenAt: routers.lastSeenAt,
        createdAt: routers.createdAt,
      });
  }

  async pollOne(router: ClaimedRouter): Promise<PollResult> {
    let password: string | null = null;
    let snapshot: RouterSnapshot | null = null;
    let failure: RouterOsError | null = null;
    try {
      try {
        password = decryptRouterPassword(
          this.box,
          { companyId: router.companyId, routerId: router.id },
          router.secret,
        );
      } catch {
        throw new RouterOsError(
          'CONFIG',
          'Mot de passe RouterOS indéchiffrable (clé ou routeur différent)',
        );
      }
      const transport = await this.transports(
        {
          transport: router.transport,
          tunnelIp: router.tunnelIp,
          tlsFingerprint: router.tlsFingerprint,
        },
        { username: router.username, password },
      );
      try {
        snapshot = await collectSnapshot(transport);
      } finally {
        await transport.close();
      }
    } catch (error) {
      failure =
        error instanceof RouterOsError
          ? new RouterOsError(error.code, sanitizeDetail(error.message, password ? [password] : []))
          : new RouterOsError('PROTOCOL', 'Erreur inattendue pendant la collecte');
    }
    password = null;

    if (snapshot) {
      await this.db
        .update(routers)
        .set({
          ...snapshot,
          status: 'ONLINE',
          consecutiveFailures: 0,
          lastSeenAt: sql`now()`,
          lastError: null,
        })
        .where(eq(routers.id, router.id));
      if (router.status !== 'ONLINE')
        this.logger.log(`Routeur ${router.id} : ${router.status} -> ONLINE`);
      return { routerId: router.id, status: 'ONLINE', outcome: 'success', error: null };
    }

    const error = failure ?? new RouterOsError('PROTOCOL', 'Collecte sans résultat');
    const outcome: PollOutcome = error.unreachable ? 'unreachable' : 'failure';
    const consecutiveFailures = router.consecutiveFailures + 1;
    const status = nextStatus(
      {
        previous: router.status,
        outcome,
        consecutiveFailures,
        lastContactAt: router.lastSeenAt ?? router.createdAt,
        now: this.clock(),
      },
      this.options.thresholds,
    );
    const lastError = `${error.code}: ${error.message}`;
    await this.db
      .update(routers)
      .set({ status, consecutiveFailures, lastError })
      .where(eq(routers.id, router.id));
    if (status !== router.status) {
      this.logger.warn(`Routeur ${router.id} : ${router.status} -> ${status} (${lastError})`);
    } else {
      this.logger.debug?.(
        `Routeur ${router.id} : ${status}, échec n° ${consecutiveFailures} (${error.code})`,
      );
    }
    return { routerId: router.id, status, outcome, error: lastError };
  }
}
