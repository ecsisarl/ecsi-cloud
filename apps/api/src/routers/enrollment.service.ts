import { createHash, randomBytes } from 'node:crypto';
import {
  ConflictException,
  GoneException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { CreateEnrollmentRequest, EnrollmentCreated, EnrollRequest } from '@ecsi/shared';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { AuditService } from '../audit/audit.service.js';
import { RATE_LIMITS, RateLimiterService } from '../auth/rate-limiter.service.js';
import { ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';
import { AUTH_DRIZZLE, type Database } from '../database/database.module.js';
import { routerEnrollmentTokens, routers } from '../database/schema/index.js';
import type { Grants } from '../tenancy/access.service.js';
import {
  type TenantContext,
  TenantDatabase,
  type TenantTransaction,
} from '../tenancy/tenant-database.js';
import { buildEnrollmentScript } from './enrollment-script.js';
import { hostOf, toRouter } from './router-view.js';
import { isUniqueViolation, newId, RoutersService } from './routers.service.js';
import { formatIpv4 } from './tunnel-ip.js';

/** Réponse unique à tout jeton refusé : ne révèle pas s'il existe, a expiré ou a servi. */
export const ENROLL_REFUSED = 'Jeton d’enrôlement invalide, expiré ou déjà utilisé';

/** Résultats de app.router_consume_enrollment (migration 0006). */
export type EnrollOutcome =
  | 'ENROLLED'
  | 'UNKNOWN'
  | 'REPLAY'
  | 'REVOKED'
  | 'EXPIRED'
  | 'NOT_PROVISIONING'
  | 'KEY_CONFLICT'
  | 'INVALID_KEY';

export const hashEnrollmentToken = (token: string) =>
  createHash('sha256').update(token, 'utf8').digest();

/**
 * Enrôlement d'un routeur (Sprint 3B), protocole lab/routeros/PROTOCOLE-PROVISIONNEMENT.md :
 *
 *  1. « Ajouter un routeur » (administrateur, ecsi_app) : routeur PROVISIONING sur un site de
 *     l'entreprise, adresse tunnel ATTRIBUÉE PAR LE CLOUD, jeton de 32 octets aléatoires
 *     (stocké haché SHA-256, usage unique, expirant), script RouterOS affiché UNE fois.
 *  2. Le routeur génère sa clé WireGuard, puis POST /routers/enroll (public, HTTPS) avec le
 *     jeton et sa clé PUBLIQUE : consommation atomique (anti-rejeu) par
 *     app.router_consume_enrollment (ecsi_auth, aucun accès direct aux tables).
 *  3. L'agent passerelle déclare le pair (adresse /32) ; le routeur initie le tunnel (NAT,
 *     CGNAT, Starlink : aucune IP WAN fixe, aucune redirection de port).
 *  4. Activation PAR LE TUNNEL auprès de l'agent passerelle (src/gateway.ts) : compte de
 *     service en lecture et empreinte TLS ; le worker vérifie puis passe le routeur ONLINE.
 */
@Injectable()
export class EnrollmentService {
  private readonly logger = new Logger(EnrollmentService.name);

  constructor(
    private readonly tenantDb: TenantDatabase,
    private readonly routersService: RoutersService,
    private readonly audit: AuditService,
    private readonly rateLimiter: RateLimiterService,
    @Inject(AUTH_DRIZZLE) private readonly authDb: Database,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /** « Ajouter un routeur » : droit routers.create sur le site choisi. */
  create(
    ctx: TenantContext,
    grants: Grants,
    input: CreateEnrollmentRequest,
  ): Promise<EnrollmentCreated> {
    const gateway = this.gatewayConfig();
    if (!grants.hasForSite('routers.create', input.siteId)) {
      return Promise.reject(new NotFoundException('Site introuvable'));
    }
    return this.tenantDb.run(ctx, async (tx) => {
      const site = await this.routersService.site(tx, ctx, input.siteId);
      if (!site) throw new NotFoundException('Site introuvable');
      const tunnelIp = await this.allocateTunnelIp(tx);
      const id = await newId(tx);
      try {
        await tx.insert(routers).values({
          id,
          companyId: ctx.companyId,
          siteId: site.id,
          name: input.name,
          status: 'PROVISIONING',
          transport: 'REST_HTTPS',
          tunnelIp,
        });
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new ConflictException('Adresse tunnel déjà attribuée, réessayez');
        }
        throw error;
      }
      const issued = await this.issueToken(tx, ctx, id);
      await this.audit.write(tx, ctx.companyId, {
        action: 'routers.enrollment.create',
        resourceType: 'router',
        resourceId: id,
        siteId: site.id,
        details: {
          name: input.name,
          site: site.code,
          tunnelIp,
          expiresAt: issued.expiresAt.toISOString(),
        },
      });
      const row = await this.routersService.byId(tx, ctx, id);
      return {
        router: toRouter(row, { id: site.id, name: site.name, code: site.code }),
        script: this.script(issued.token, tunnelIp, gateway),
        expiresAt: issued.expiresAt.toISOString(),
      };
    });
  }

  /**
   * Nouveau jeton (et nouveau script) pour un routeur pas encore enrôlé : les jetons non
   * utilisés sont révoqués. Un routeur déjà enrôlé (clé publique reçue) n'est pas
   * réenrôlable : il faut le supprimer et l'ajouter à nouveau.
   */
  renew(ctx: TenantContext, grants: Grants, routerId: string): Promise<EnrollmentCreated> {
    const gateway = this.gatewayConfig();
    return this.tenantDb.run(ctx, async (tx) => {
      const row = await this.routersService.inScope(tx, ctx, grants, routerId, 'routers.create');
      if (row.status !== 'PROVISIONING' || row.wgPublicKey !== null) {
        throw new ConflictException('Routeur déjà enrôlé : supprimez-le puis ajoutez-le à nouveau');
      }
      const revoked = await tx
        .update(routerEnrollmentTokens)
        .set({ revokedAt: new Date() })
        .where(
          and(
            eq(routerEnrollmentTokens.companyId, ctx.companyId),
            eq(routerEnrollmentTokens.routerId, routerId),
            isNull(routerEnrollmentTokens.usedAt),
            isNull(routerEnrollmentTokens.revokedAt),
          ),
        )
        .returning({ id: routerEnrollmentTokens.id });
      const issued = await this.issueToken(tx, ctx, routerId);
      await this.audit.write(tx, ctx.companyId, {
        action: 'routers.enrollment.renew',
        resourceType: 'router',
        resourceId: routerId,
        siteId: row.siteId,
        details: {
          name: row.name,
          revoked: revoked.length,
          expiresAt: issued.expiresAt.toISOString(),
        },
      });
      return {
        router: toRouter(row, { id: row.siteId, name: row.siteName, code: row.siteCode }),
        script: this.script(issued.token, hostOf(row.tunnelIp), gateway),
        expiresAt: issued.expiresAt.toISOString(),
      };
    });
  }

  /**
   * Point d'entrée PUBLIC du routeur. Limité par adresse IP ; tout refus répond 410 avec le
   * même message et est audité (résultat DENIED, motif précis dans le journal seulement).
   */
  async enroll(body: EnrollRequest, ip: string): Promise<{ status: 'enrolled' }> {
    await this.rateLimiter.consume(`router-enroll:ip:${ip}`, RATE_LIMITS.routerEnrollPerIp);
    const result = await this.authDb.execute<{
      outcome: EnrollOutcome;
      router_id: string | null;
      company_id: string | null;
      site_id: string | null;
      tunnel_ip: string | null;
    }>(
      sql`select * from app.router_consume_enrollment(${hashEnrollmentToken(body.token)}, ${body.publicKey})`,
    );
    const row = result.rows[0];
    const outcome = row?.outcome ?? 'UNKNOWN';
    const actor = { type: 'ANONYMOUS' as const, id: null, label: 'routeur (jeton d’enrôlement)' };
    if (outcome === 'ENROLLED' && row) {
      await this.audit.writeDirect(
        row.company_id,
        {
          action: 'routers.enroll',
          resourceType: 'router',
          resourceId: row.router_id,
          siteId: row.site_id,
          details: { tunnelIp: row.tunnel_ip ? hostOf(row.tunnel_ip) : null },
        },
        actor,
      );
      return { status: 'enrolled' };
    }
    await this.audit.writeDirect(
      row?.company_id ?? null,
      {
        action: 'routers.enroll',
        resourceType: 'router',
        resourceId: row?.router_id ?? null,
        result: 'DENIED',
        details: { reason: outcome },
      },
      actor,
    );
    this.logger.warn({ outcome }, 'Enrôlement de routeur refusé');
    throw new GoneException(ENROLL_REFUSED);
  }

  // ---------------------------------------------------------------------------------

  private gatewayConfig() {
    const { WG_GATEWAY_PUBLIC_KEY: publicKey, WG_GATEWAY_ENDPOINT: endpoint } = this.env;
    if (!publicKey || !endpoint) {
      throw new ServiceUnavailableException(
        'Passerelle WireGuard non configurée (WG_GATEWAY_PUBLIC_KEY, WG_GATEWAY_ENDPOINT)',
      );
    }
    // Le routeur vérifie le certificat de l'API (check-certificate=yes) : HTTPS obligatoire.
    const enrollUrl =
      this.env.ROUTER_ENROLL_PUBLIC_URL ??
      `${this.env.WEB_PUBLIC_URL.replace(/\/+$/, '')}/api/v1/routers/enroll`;
    if (!enrollUrl.startsWith('https://')) {
      throw new ServiceUnavailableException(
        'URL publique d’enrôlement HTTPS requise (ROUTER_ENROLL_PUBLIC_URL ou WEB_PUBLIC_URL)',
      );
    }
    return { publicKey, endpoint, enrollUrl };
  }

  private async allocateTunnelIp(tx: TenantTransaction): Promise<string> {
    const network = this.routersService.tunnelNetwork;
    try {
      const result = await tx.execute<{ ip: string }>(
        sql`select host(app.router_allocate_tunnel_ip(${network.cidr}::cidr, ${formatIpv4(network.gateway)}::inet)) as ip`,
      );
      const ip = result.rows[0]?.ip;
      if (!ip) throw new Error('Attribution d’adresse tunnel sans résultat');
      // Défense en profondeur : l'adresse renvoyée repasse la validation anti-SSRF.
      return this.routersService.validTunnelIp(ip);
    } catch (error) {
      const code =
        (error as { cause?: { code?: string } }).cause?.code ?? (error as { code?: string }).code;
      if (code === 'EC001') {
        throw new ConflictException('Plus aucune adresse tunnel libre dans la plage configurée');
      }
      throw error;
    }
  }

  private async issueToken(tx: TenantTransaction, ctx: TenantContext, routerId: string) {
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + this.env.ROUTER_ENROLL_TOKEN_TTL_MINUTES * 60_000);
    await tx.insert(routerEnrollmentTokens).values({
      companyId: ctx.companyId,
      routerId,
      tokenHash: hashEnrollmentToken(token),
      expiresAt,
      createdBy: ctx.userId,
    });
    return { token, expiresAt };
  }

  private script(
    token: string,
    tunnelIp: string,
    gateway: { publicKey: string; endpoint: string; enrollUrl: string },
  ) {
    const network = this.routersService.tunnelNetwork;
    const ca =
      this.env.ROUTER_ENROLL_CA_URL && this.env.ROUTER_ENROLL_CA_FINGERPRINT
        ? { url: this.env.ROUTER_ENROLL_CA_URL, fingerprint: this.env.ROUTER_ENROLL_CA_FINGERPRINT }
        : null;
    return buildEnrollmentScript({
      token,
      enrollUrl: gateway.enrollUrl,
      gatewayTunnelIp: formatIpv4(network.gateway),
      activationPort: this.env.ROUTER_ACTIVATION_PORT,
      gatewayPublicKey: gateway.publicKey,
      gatewayEndpoint: gateway.endpoint,
      gatewayPort: this.env.WG_GATEWAY_PORT,
      tunnelIp,
      tunnelPrefix: network.prefix,
      ttlMinutes: this.env.ROUTER_ENROLL_TOKEN_TTL_MINUTES,
      ca,
    });
  }
}
