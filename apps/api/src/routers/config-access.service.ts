import { createHash, randomBytes } from 'node:crypto';
import { ConflictException, Inject, Injectable, ServiceUnavailableException } from '@nestjs/common';
import type { RouterConfigAccess, RouterConfigAccessScript } from '@ecsi/shared';
import { and, eq, sql } from 'drizzle-orm';
import { AuditService } from '../audit/audit.service.js';
import { ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';
import { routerConfigAccounts } from '../database/schema/index.js';
import type { Grants } from '../tenancy/access.service.js';
import {
  type TenantContext,
  TenantDatabase,
  type TenantTransaction,
} from '../tenancy/tenant-database.js';
import {
  buildConfigAccessScript,
  CONFIG_GROUP_POLICY,
  CONFIG_USER,
} from './config-access-script.js';
import { hostOf } from './router-view.js';
import { RoutersService } from './routers.service.js';
import { formatIpv4 } from './tunnel-ip.js';

export const hashConfigAccessToken = (token: string) =>
  createHash('sha256').update(token, 'utf8').digest();

type AccountRow = {
  activatedAt: Date | null;
  tokenExpiresAt: Date | null;
};

export function configAccessView(row: AccountRow | undefined, now: Date): RouterConfigAccess {
  const pending = row?.tokenExpiresAt && row.tokenExpiresAt > now ? row.tokenExpiresAt : null;
  const activatedAt = row?.activatedAt ?? null;
  return {
    status: activatedAt ? 'ACTIVE' : pending ? 'PENDING' : 'NONE',
    activatedAt: activatedAt?.toISOString() ?? null,
    expiresAt: pending?.toISOString() ?? null,
  };
}

/**
 * Compte d'écriture RouterOS ecsi-cfg (lot B, décision du propriétaire : compte séparé, le
 * compte de supervision ecsi-svc n'est jamais élevé). L'API émet un jeton à usage unique
 * (32 octets aléatoires, stocké haché SHA-256, expirant) et le script d'activation ; le
 * routeur génère le mot de passe et l'envoie par le tunnel à l'agent passerelle, qui le
 * chiffre (activation-server.ts, migration 0009). L'API ne lit JAMAIS le chiffré (privilèges
 * par colonne) ; le script et le jeton ne sont ni journalisés ni audités.
 */
@Injectable()
export class ConfigAccessService {
  constructor(
    private readonly tenantDb: TenantDatabase,
    private readonly routersService: RoutersService,
    private readonly audit: AuditService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  get(ctx: TenantContext, grants: Grants, routerId: string): Promise<RouterConfigAccess> {
    return this.tenantDb.run(ctx, async (tx) => {
      await this.routersService.inScope(tx, ctx, grants, routerId, 'routers.read');
      return configAccessView(await this.account(tx, ctx, routerId), new Date());
    });
  }

  issue(ctx: TenantContext, grants: Grants, routerId: string): Promise<RouterConfigAccessScript> {
    const gatewayPublicKey = this.env.WG_GATEWAY_PUBLIC_KEY;
    if (!gatewayPublicKey) {
      return Promise.reject(
        new ServiceUnavailableException(
          'Passerelle WireGuard non configurée (WG_GATEWAY_PUBLIC_KEY)',
        ),
      );
    }
    return this.tenantDb.run(ctx, async (tx) => {
      const row = await this.routersService.inScope(
        tx,
        ctx,
        grants,
        routerId,
        'routers.command.dangerous',
      );
      if (row.status === 'PROVISIONING' || row.wgPublicKey === null) {
        throw new ConflictException(
          'Routeur pas encore enrôlé et activé : terminer d’abord l’enrôlement',
        );
      }
      const token = randomBytes(32).toString('base64url');
      const expiresAt = new Date(Date.now() + this.env.ROUTER_ENROLL_TOKEN_TTL_MINUTES * 60_000);
      const values = {
        tokenHash: hashConfigAccessToken(token),
        tokenExpiresAt: expiresAt,
        tokenCreatedBy: ctx.userId,
      };
      const existing = await this.account(tx, ctx, routerId);
      if (existing) {
        await tx
          .update(routerConfigAccounts)
          .set(values)
          .where(
            and(
              eq(routerConfigAccounts.companyId, ctx.companyId),
              eq(routerConfigAccounts.routerId, routerId),
            ),
          );
      } else {
        // Colonnes explicites : Drizzle écrirait DEFAULT dans toutes les autres, ce que les
        // privilèges par colonne d'ecsi_app refusent (password_encrypted, username…).
        await tx.execute(sql`
          insert into router_config_accounts
            (router_id, company_id, token_hash, token_expires_at, token_created_by)
          values (${routerId}, ${ctx.companyId}, ${values.tokenHash}, ${expiresAt.toISOString()},
                  ${ctx.userId})`);
      }
      const network = this.routersService.tunnelNetwork;
      const script = buildConfigAccessScript({
        token,
        gatewayTunnelIp: formatIpv4(network.gateway),
        activationPort: this.env.ROUTER_ACTIVATION_PORT,
        gatewayPublicKey,
        tunnelIp: hostOf(row.tunnelIp),
        tunnelPrefix: network.prefix,
        ttlMinutes: this.env.ROUTER_ENROLL_TOKEN_TTL_MINUTES,
      });
      // Audit sans le script ni le jeton.
      await this.audit.write(tx, ctx.companyId, {
        action: 'routers.config_access.create',
        resourceType: 'router',
        resourceId: routerId,
        siteId: row.siteId,
        details: {
          router: row.name,
          routerosUsername: CONFIG_USER,
          policy: CONFIG_GROUP_POLICY,
          replacesActive: Boolean(existing?.activatedAt),
          expiresAt: expiresAt.toISOString(),
        },
      });
      return { script, expiresAt: expiresAt.toISOString() };
    });
  }

  private async account(
    tx: TenantTransaction,
    ctx: TenantContext,
    routerId: string,
  ): Promise<AccountRow | undefined> {
    const [row] = await tx
      .select({
        activatedAt: routerConfigAccounts.activatedAt,
        tokenExpiresAt: routerConfigAccounts.tokenExpiresAt,
      })
      .from(routerConfigAccounts)
      .where(
        and(
          eq(routerConfigAccounts.companyId, ctx.companyId),
          eq(routerConfigAccounts.routerId, routerId),
        ),
      );
    return row;
  }
}
