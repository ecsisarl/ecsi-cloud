import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { SecretBox } from '../../auth/crypto/secret-box.js';
import { nasSecret } from '../../hotspot/radius-keys.js';
import { decryptRouterConfigPassword } from '../router-secret.js';
import { RouterOsError, sanitizeDetail } from '../routeros/errors.js';
import type { WriterFactory } from '../routeros/writer.js';
import { formatIpv4, type TunnelNetwork } from '../tunnel-ip.js';
import { reconcileHotspot, type ReconcileReport } from './reconcile.js';

export interface ProvisionerOptions {
  /** Hotspots traités par cycle (un seul job par routeur à la fois). */
  readonly batchSize: number;
  /** Délai avant une nouvelle tentative d'un Hotspot en ERROR. */
  readonly retrySeconds: number;
  /** Job APPLYING abandonné (worker arrêté en cours) : repris après ce délai. */
  readonly staleSeconds: number;
}

export const DEFAULT_PROVISIONER_OPTIONS: ProvisionerOptions = {
  batchSize: 10,
  retrySeconds: 300,
  staleSeconds: 600,
};

export interface ProvisionerLogger {
  log(message: string): void;
  warn(message: string): void;
}

export interface ClaimedHotspot {
  readonly hotspotId: string;
  readonly companyId: string;
  readonly routerId: string;
  readonly interface: string;
  readonly gatewayAddress: string;
  readonly poolStart: string;
  readonly poolEnd: string;
  readonly dnsName: string | null;
  readonly enabled: boolean;
  readonly configVersion: number;
  readonly nasSecretVersion: number;
  readonly tunnelIp: string;
  readonly tlsFingerprint: string | null;
  readonly username: string;
  readonly passwordEncrypted: string;
}

export interface ProvisionResult {
  readonly hotspotId: string;
  readonly status: 'SYNCED' | 'ERROR';
  readonly report: ReconcileReport | null;
  readonly error: string | null;
}

/**
 * Réconciliation Hotspot dans le worker (rôle ecsi_worker, migrations 0008 et 0009).
 *
 * Réservation : une transaction par Hotspot, SELECT … FOR UPDATE OF h, r SKIP LOCKED puis
 * passage à APPLYING ; un Hotspot n'est réservé que si AUCUN autre Hotspot du même routeur
 * n'est en APPLYING récent : un seul job par routeur, même avec plusieurs workers. Éligible :
 * PENDING, ERROR après retrySeconds, APPLYING abandonné après staleSeconds ; routeur ONLINE
 * avec un compte ecsi-cfg ACTIF. Le résultat n'est écrit que si le Hotspot est encore
 * APPLYING (une modification faite entre-temps par l'API le repasse en PENDING : la nouvelle
 * version sera appliquée au cycle suivant). Mots de passe et secret RADIUS : en mémoire le
 * temps du job seulement, jamais journalisés ni stockés (last_error nettoyé).
 */
export class HotspotProvisioner {
  constructor(
    private readonly db: NodePgDatabase<Record<string, unknown>>,
    private readonly box: SecretBox,
    private readonly writers: WriterFactory,
    private readonly network: TunnelNetwork,
    private readonly nasKey: string,
    private readonly options: ProvisionerOptions = DEFAULT_PROVISIONER_OPTIONS,
    private readonly logger: ProvisionerLogger = { log: () => undefined, warn: () => undefined },
  ) {}

  async runCycle(): Promise<ProvisionResult[]> {
    const results: ProvisionResult[] = [];
    for (let i = 0; i < this.options.batchSize; i += 1) {
      const job = await this.claimOne();
      if (!job) break;
      results.push(await this.apply(job));
    }
    return results;
  }

  async claimOne(): Promise<ClaimedHotspot | null> {
    return this.db.transaction(async (tx) => {
      const found = await tx.execute<{ id: string }>(sql`
        select h.id
          from hotspots h
          join routers r on r.id = h.router_id and r.company_id = h.company_id
          join router_config_accounts a on a.router_id = r.id and a.company_id = r.company_id
         where r.deleted_at is null and r.status = 'ONLINE'
           and a.password_encrypted is not null
           and (h.sync_status = 'PENDING'
                or (h.sync_status = 'ERROR'
                    and (h.last_sync_at is null
                         or h.last_sync_at <= now() - make_interval(secs => ${this.options.retrySeconds})))
                or (h.sync_status = 'APPLYING'
                    and (h.last_sync_at is null
                         or h.last_sync_at <= now() - make_interval(secs => ${this.options.staleSeconds}))))
           and not exists (
             select 1 from hotspots o
              where o.router_id = h.router_id and o.id <> h.id and o.sync_status = 'APPLYING'
                and o.last_sync_at > now() - make_interval(secs => ${this.options.staleSeconds}))
         order by h.deleted_at asc nulls last, h.last_sync_at asc nulls first
         limit 1
         for update of h, r skip locked`);
      const id = found.rows[0]?.id;
      if (!id) return null;
      const claimed = await tx.execute<{
        hotspot_id: string;
        company_id: string;
        router_id: string;
        interface: string;
        gateway_address: string;
        pool_start: string;
        pool_end: string;
        dns_name: string | null;
        enabled: boolean;
        config_version: number;
        nas_secret_version: number;
        tunnel_ip: string;
        tls_fingerprint: string | null;
        username: string;
        password_encrypted: string;
      }>(sql`
        with up as (
          update hotspots set sync_status = 'APPLYING', last_sync_at = now()
           where id = ${id}
           returning id, company_id, router_id, interface, gateway_address, pool_start,
                     pool_end, dns_name, desired_state, deleted_at, config_version,
                     nas_secret_version)
        select up.id as hotspot_id, up.company_id, up.router_id, up.interface,
               up.gateway_address::text as gateway_address, host(up.pool_start) as pool_start,
               host(up.pool_end) as pool_end, up.dns_name,
               (up.desired_state = 'ENABLED' and up.deleted_at is null) as enabled,
               up.config_version, up.nas_secret_version, host(r.tunnel_ip) as tunnel_ip,
               r.tls_fingerprint, a.username, a.password_encrypted
          from up
          join routers r on r.id = up.router_id and r.company_id = up.company_id
          join router_config_accounts a on a.router_id = r.id and a.company_id = r.company_id`);
      const row = claimed.rows[0];
      if (!row) return null;
      return {
        hotspotId: row.hotspot_id,
        companyId: row.company_id,
        routerId: row.router_id,
        interface: row.interface,
        gatewayAddress: row.gateway_address,
        poolStart: row.pool_start,
        poolEnd: row.pool_end,
        dnsName: row.dns_name,
        enabled: row.enabled,
        configVersion: row.config_version,
        nasSecretVersion: row.nas_secret_version,
        tunnelIp: row.tunnel_ip,
        tlsFingerprint: row.tls_fingerprint,
        username: row.username,
        passwordEncrypted: row.password_encrypted,
      };
    });
  }

  async apply(job: ClaimedHotspot): Promise<ProvisionResult> {
    let password: string | null = null;
    let secret: string | null = null;
    let report: ReconcileReport | null = null;
    let failure: RouterOsError | null = null;
    try {
      try {
        password = decryptRouterConfigPassword(
          this.box,
          { companyId: job.companyId, routerId: job.routerId },
          job.passwordEncrypted,
        );
      } catch {
        throw new RouterOsError(
          'CONFIG',
          'Mot de passe du compte ecsi-cfg indéchiffrable (clé ou routeur différent)',
        );
      }
      secret = nasSecret(this.nasKey, job.routerId, job.nasSecretVersion);
      const writer = this.writers(
        { tunnelIp: job.tunnelIp, tlsFingerprint: job.tlsFingerprint },
        { username: job.username, password },
      );
      report = await reconcileHotspot(
        writer,
        {
          hotspotId: job.hotspotId,
          interface: job.interface,
          gatewayAddress: job.gatewayAddress,
          poolStart: job.poolStart,
          poolEnd: job.poolEnd,
          dnsName: job.dnsName,
          radiusServer: formatIpv4(this.network.gateway),
          routerTunnelIp: job.tunnelIp,
          radiusSecret: secret,
        },
        job.enabled,
      );
    } catch (error) {
      const masks = [password, secret].filter((value): value is string => Boolean(value));
      failure =
        error instanceof RouterOsError
          ? new RouterOsError(error.code, sanitizeDetail(error.message, masks))
          : new RouterOsError('PROTOCOL', 'Erreur inattendue pendant la synchronisation');
    }
    password = null;
    secret = null;

    const status = failure ? 'ERROR' : 'SYNCED';
    const lastError = failure ? `${failure.code}: ${failure.message}` : null;
    await this.db.execute(sql`
      update hotspots
         set sync_status = ${status},
             applied_version = case when ${status} = 'SYNCED' then ${job.configVersion}::int
                                    else applied_version end,
             last_sync_at = now(), last_error = ${lastError}
       where id = ${job.hotspotId} and sync_status = 'APPLYING'`);
    if (failure) {
      this.logger.warn(`Hotspot ${job.hotspotId} (routeur ${job.routerId}) : ERROR (${lastError})`);
    } else if (report) {
      this.logger.log(
        `Hotspot ${job.hotspotId} (routeur ${job.routerId}) : SYNCED v${job.configVersion} ${job.enabled ? 'activé' : 'retiré'} (${report.added} ajout(s), ${report.updated} modification(s), ${report.removed} retrait(s))`,
      );
    }
    return { hotspotId: job.hotspotId, status, report, error: lastError };
  }

  /** Entretien RADIUS (migration 0008) : expiration des tickets, sessions orphelines, purge. */
  async housekeeping(): Promise<{
    expired: number;
    staleSessions: number;
    purgedPostauth: number;
  }> {
    const result = await this.db.execute<{
      expired: number | string;
      stale_sessions: number | string;
      purged_postauth: number | string;
    }>(sql`select expired, stale_sessions, purged_postauth from radius.housekeeping()`);
    const row = result.rows[0];
    return {
      expired: Number(row?.expired ?? 0),
      staleSessions: Number(row?.stale_sessions ?? 0),
      purgedPostauth: Number(row?.purged_postauth ?? 0),
    };
  }
}
