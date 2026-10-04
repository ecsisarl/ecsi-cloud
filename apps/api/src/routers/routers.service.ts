import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type {
  ListRoutersQuery,
  RegisterRouterRequest,
  Router,
  RouterCredentialsRequest,
  RouterDetail,
  UpdateRouterRequest,
} from '@ecsi/shared';
import { and, asc, desc, eq, ilike, inArray, isNull, or, type SQL, sql } from 'drizzle-orm';
import { AuditService } from '../audit/audit.service.js';
import { SecretBox } from '../auth/crypto/secret-box.js';
import { SECRET_BOX } from '../auth/secret-box.provider.js';
import { ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';
import {
  routerEnrollmentTokens,
  routers,
  sites,
  type RouterTransportKind,
} from '../database/schema/index.js';
import type { Grants } from '../tenancy/access.service.js';
import {
  type TenantContext,
  TenantDatabase,
  type TenantTransaction,
} from '../tenancy/tenant-database.js';
import { encryptRouterPassword } from './router-secret.js';
import {
  hostOf,
  ROUTER_VIEW_COLUMNS,
  type RouterViewRow,
  type SiteRef,
  toRouter,
  toRouterDetail,
} from './router-view.js';
import {
  assertRouterTunnelIp,
  parseTunnelNetwork,
  TunnelIpError,
  type TunnelNetwork,
} from './tunnel-ip.js';

export interface RegisterRouterInput {
  siteId: string;
  name: string;
  tunnelIp: string;
  transport: RouterTransportKind;
  routerosUsername: string;
  routerosPassword: string;
  tlsFingerprint?: string | null;
}

/** Vue interne d'un routeur : jamais le chiffré du mot de passe. */
export type RouterView = RouterViewRow;

type RouterPermission = 'routers.read' | 'routers.create' | 'routers.update' | 'routers.delete';

export const ROUTER_NOT_FOUND = 'Routeur introuvable';
const SITE_NOT_FOUND = 'Site introuvable';
const USERNAME = /^[A-Za-z0-9._-]{1,64}$/;
const FINGERPRINT = /^[0-9a-f]{64}$/;

const viewSelection = {
  ...ROUTER_VIEW_COLUMNS,
  hasPassword: sql<boolean>`(${routers.routerosPasswordEncrypted} is not null)`,
  siteName: sites.name,
  siteCode: sites.code,
};

type JoinedRow = RouterViewRow & { siteName: string; siteCode: string };

const siteOf = (row: JoinedRow): SiteRef => ({
  id: row.siteId,
  name: row.siteName,
  code: row.siteCode,
});

export function isUniqueViolation(error: unknown): boolean {
  return (
    (error as { cause?: { code?: string } }).cause?.code === '23505' ||
    (error as { code?: string }).code === '23505'
  );
}

/**
 * Routeurs de l'entreprise courante (rôle ecsi_app, RLS) : Super Admin ECSI → Entreprise →
 * Site → Routeur.
 *
 * Portée par site (comme les sites, Sprint 2) : la liste ne contient que les routeurs des
 * sites où l'utilisateur détient routers.read ; un routeur hors de cette portée, supprimé ou
 * d'une autre entreprise répond 404 (la RLS l'aurait de toute façon masqué). L'identifiant
 * reçu dans l'URL n'est jamais une source de droits.
 *
 * Secrets : le mot de passe RouterOS est chiffré (SecretBox, AAD liée à l'entreprise et au
 * routeur) et n'est JAMAIS relu par l'API ; les vues n'exposent que hasCredentials.
 * Toute modification est auditée dans la transaction (AuditService.write).
 */
@Injectable()
export class RoutersService {
  private readonly network: TunnelNetwork;

  constructor(
    private readonly tenantDb: TenantDatabase,
    @Inject(SECRET_BOX) private readonly box: SecretBox,
    @Inject(ENV) env: Env,
    private readonly audit: AuditService,
  ) {
    this.network = parseTunnelNetwork(env.ROUTER_TUNNEL_CIDR, env.ROUTER_TUNNEL_GATEWAY);
  }

  // --- Lecture -----------------------------------------------------------------

  list(ctx: TenantContext, grants: Grants, query: ListRoutersQuery = {}): Promise<Router[]> {
    const scope = grants.sitesFor('routers.read');
    if (scope !== 'ALL' && scope.length === 0) return Promise.resolve([]);
    return this.tenantDb.run(ctx, async (tx) => {
      const filters: (SQL | undefined)[] = [
        eq(routers.companyId, ctx.companyId),
        isNull(routers.deletedAt),
        scope === 'ALL' ? undefined : inArray(routers.siteId, scope),
        query.siteId ? eq(routers.siteId, query.siteId) : undefined,
        query.status ? eq(routers.status, query.status) : undefined,
      ];
      if (query.q) {
        const pattern = `%${query.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
        filters.push(
          or(
            ilike(routers.name, pattern),
            ilike(routers.identity, pattern),
            ilike(routers.boardName, pattern),
            sql`host(${routers.tunnelIp}) ilike ${pattern}`,
          ),
        );
      }
      const rows = await this.joined(tx)
        .where(and(...filters))
        .orderBy(asc(sites.name), asc(routers.name));
      return rows.map((row) => toRouter(row, siteOf(row)));
    });
  }

  get(ctx: TenantContext, grants: Grants, routerId: string): Promise<RouterDetail> {
    return this.tenantDb.run(ctx, async (tx) => {
      const row = await this.inScope(tx, ctx, grants, routerId, 'routers.read');
      const [token] = await tx
        .select({
          expiresAt: routerEnrollmentTokens.expiresAt,
          usedAt: routerEnrollmentTokens.usedAt,
        })
        .from(routerEnrollmentTokens)
        .where(
          and(
            eq(routerEnrollmentTokens.companyId, ctx.companyId),
            eq(routerEnrollmentTokens.routerId, routerId),
            isNull(routerEnrollmentTokens.revokedAt),
          ),
        )
        .orderBy(desc(routerEnrollmentTokens.createdAt))
        .limit(1);
      return toRouterDetail(row, siteOf(row), token ?? null);
    });
  }

  // --- Enregistrement manuel ------------------------------------------------------

  /**
   * Enregistrement d'un routeur déjà configuré à la main (ex. CHR-LAB du Sprint 3A), au nom
   * de l'utilisateur : droit routers.create sur le site visé, audit.
   */
  create(ctx: TenantContext, grants: Grants, input: RegisterRouterRequest): Promise<Router> {
    if (!grants.hasForSite('routers.create', input.siteId)) {
      return Promise.reject(new NotFoundException(SITE_NOT_FOUND));
    }
    return this.tenantDb.run(ctx, async (tx) => {
      const id = await this.insertManual(tx, ctx, input);
      const row = await this.byId(tx, ctx, id);
      await this.audit.write(tx, ctx.companyId, {
        action: 'routers.create',
        resourceType: 'router',
        resourceId: id,
        siteId: row.siteId,
        details: {
          mode: 'manual',
          name: row.name,
          site: row.siteCode,
          tunnelIp: hostOf(row.tunnelIp),
          transport: row.transport,
          routerosUsername: row.routerosUsername,
        },
      });
      return toRouter(row, siteOf(row));
    });
  }

  /**
   * Enregistrement sans contrôle de portée ni audit utilisateur (outils internes et tests
   * S3A). Les contrôles de données (adresse tunnel, identifiants, site de l'entreprise)
   * sont identiques.
   */
  register(context: TenantContext, input: RegisterRouterInput): Promise<RouterView> {
    return this.tenantDb.run(context, async (tx) => {
      const id = await this.insertManual(tx, context, input);
      const { siteName: _n, siteCode: _c, ...row } = await this.byId(tx, context, id);
      return row;
    });
  }

  // --- Modification ---------------------------------------------------------------

  update(
    ctx: TenantContext,
    grants: Grants,
    routerId: string,
    input: UpdateRouterRequest,
  ): Promise<Router> {
    return this.tenantDb.run(ctx, async (tx) => {
      const before = await this.inScope(tx, ctx, grants, routerId, 'routers.update');
      const changes: Record<string, { before: unknown; after: unknown }> = {};
      const set: { name?: string; siteId?: string } = {};
      if (input.name !== undefined && input.name !== before.name) {
        set.name = input.name;
        changes.name = { before: before.name, after: input.name };
      }
      if (input.siteId !== undefined && input.siteId !== before.siteId) {
        // Déplacement : le site cible doit être de l'entreprise, actif, et dans la portée.
        const target = await this.site(tx, ctx, input.siteId);
        if (!target || !grants.hasForSite('routers.update', target.id)) {
          throw new NotFoundException(SITE_NOT_FOUND);
        }
        set.siteId = target.id;
        changes.site = { before: before.siteCode, after: target.code };
      }
      if (Object.keys(set).length > 0) {
        await tx
          .update(routers)
          .set(set)
          .where(
            and(
              eq(routers.id, routerId),
              eq(routers.companyId, ctx.companyId),
              isNull(routers.deletedAt),
            ),
          );
        await this.audit.write(tx, ctx.companyId, {
          action: 'routers.update',
          resourceType: 'router',
          resourceId: routerId,
          siteId: set.siteId ?? before.siteId,
          details: { router: before.name, changes },
        });
      }
      const row = await this.byId(tx, ctx, routerId);
      return toRouter(row, siteOf(row));
    });
  }

  /**
   * Suppression logique : le routeur disparaît de l'API et du worker (RLS ecsi_worker), son
   * adresse tunnel est mise en quarantaine 7 jours (app.router_allocate_tunnel_ip), l'agent
   * passerelle retire son pair WireGuard, ses jetons d'enrôlement non utilisés sont révoqués.
   */
  remove(ctx: TenantContext, grants: Grants, routerId: string): Promise<void> {
    return this.tenantDb.run(ctx, async (tx) => {
      const before = await this.inScope(tx, ctx, grants, routerId, 'routers.delete');
      await tx
        .update(routers)
        .set({ deletedAt: new Date() })
        .where(and(eq(routers.id, routerId), eq(routers.companyId, ctx.companyId)));
      await tx
        .update(routerEnrollmentTokens)
        .set({ revokedAt: new Date() })
        .where(
          and(
            eq(routerEnrollmentTokens.companyId, ctx.companyId),
            eq(routerEnrollmentTokens.routerId, routerId),
            isNull(routerEnrollmentTokens.usedAt),
            isNull(routerEnrollmentTokens.revokedAt),
          ),
        );
      await this.audit.write(tx, ctx.companyId, {
        action: 'routers.delete',
        resourceType: 'router',
        resourceId: routerId,
        siteId: before.siteId,
        details: {
          name: before.name,
          site: before.siteCode,
          tunnelIp: hostOf(before.tunnelIp),
          status: before.status,
        },
      });
    });
  }

  /**
   * Changement des identifiants RouterOS (compte de service renouvelé sur le routeur). Le
   * nouveau mot de passe est chiffré immédiatement ; l'ancien chiffré est remplacé ; rien
   * n'est renvoyé. Le worker recollecte le routeur au cycle suivant (last_sync_at remis à
   * NULL). Interdit pendant l'enrôlement : les identifiants viennent alors de l'activation.
   */
  changeCredentials(
    ctx: TenantContext,
    grants: Grants,
    routerId: string,
    input: RouterCredentialsRequest,
  ): Promise<Router> {
    return this.tenantDb.run(ctx, async (tx) => {
      const before = await this.inScope(tx, ctx, grants, routerId, 'routers.update');
      if (before.status === 'PROVISIONING') {
        throw new ConflictException(
          'Routeur en cours d’enrôlement : ses identifiants seront fournis par le script',
        );
      }
      const fingerprint =
        input.tlsFingerprint === undefined ? before.tlsFingerprint : input.tlsFingerprint;
      this.assertCredentials(input.routerosUsername, input.routerosPassword);
      if (before.transport === 'REST_HTTPS' && !fingerprint) {
        throw new UnprocessableEntityException(
          'Le transport REST HTTPS exige l’empreinte TLS du routeur',
        );
      }
      await tx
        .update(routers)
        .set({
          routerosUsername: input.routerosUsername,
          routerosPasswordEncrypted: encryptRouterPassword(
            this.box,
            { companyId: ctx.companyId, routerId },
            input.routerosPassword,
          ),
          tlsFingerprint: fingerprint,
          lastSyncAt: null,
        })
        .where(
          and(
            eq(routers.id, routerId),
            eq(routers.companyId, ctx.companyId),
            isNull(routers.deletedAt),
          ),
        );
      await this.audit.write(tx, ctx.companyId, {
        action: 'routers.credentials.update',
        resourceType: 'router',
        resourceId: routerId,
        siteId: before.siteId,
        details: {
          router: before.name,
          routerosUsername: { before: before.routerosUsername, after: input.routerosUsername },
          tlsPinningChanged: fingerprint !== before.tlsFingerprint,
        },
      });
      const row = await this.byId(tx, ctx, routerId);
      return toRouter(row, siteOf(row));
    });
  }

  /** Identifiants sans contrôle de portée ni audit utilisateur (outils internes, tests S3A). */
  async setCredentials(
    context: TenantContext,
    routerId: string,
    credentials: { routerosUsername: string; routerosPassword: string },
  ): Promise<void> {
    this.assertCredentials(credentials.routerosUsername, credentials.routerosPassword);
    await this.tenantDb.run(context, async (tx) => {
      const updated = await tx
        .update(routers)
        .set({
          routerosUsername: credentials.routerosUsername,
          routerosPasswordEncrypted: encryptRouterPassword(
            this.box,
            { companyId: context.companyId, routerId },
            credentials.routerosPassword,
          ),
        })
        .where(and(eq(routers.id, routerId), isNull(routers.deletedAt)))
        .returning({ id: routers.id });
      if (updated.length === 0) throw new NotFoundException(ROUTER_NOT_FOUND);
    });
  }

  // --- Outils partagés avec l'enrôlement --------------------------------------------

  /** Routeur actif de l'entreprise, dans la portée de la permission ; sinon 404 / 403. */
  async inScope(
    tx: TenantTransaction,
    ctx: TenantContext,
    grants: Grants,
    routerId: string,
    permission: RouterPermission,
  ): Promise<JoinedRow> {
    const [row] = await this.joined(tx).where(
      and(
        eq(routers.id, routerId),
        eq(routers.companyId, ctx.companyId),
        isNull(routers.deletedAt),
      ),
    );
    if (!row || !grants.hasForSite('routers.read', row.siteId)) {
      throw new NotFoundException(ROUTER_NOT_FOUND);
    }
    if (!grants.hasForSite(permission, row.siteId)) {
      throw new ForbiddenException(
        "Vous n'avez pas la permission d'effectuer cette action sur ce routeur",
      );
    }
    return row;
  }

  async byId(tx: TenantTransaction, ctx: TenantContext, routerId: string): Promise<JoinedRow> {
    const [row] = await this.joined(tx).where(
      and(eq(routers.id, routerId), eq(routers.companyId, ctx.companyId)),
    );
    if (!row) throw new NotFoundException(ROUTER_NOT_FOUND);
    return row;
  }

  /** Site actif de l'entreprise courante (la RLS masque déjà ceux des autres). */
  async site(tx: TenantTransaction, ctx: TenantContext, siteId: string): Promise<SiteRef | null> {
    const [row] = await tx
      .select({ id: sites.id, name: sites.name, code: sites.code })
      .from(sites)
      .where(
        and(eq(sites.id, siteId), eq(sites.companyId, ctx.companyId), isNull(sites.deletedAt)),
      );
    return row ?? null;
  }

  validTunnelIp(value: string): string {
    try {
      return assertRouterTunnelIp(value, this.network);
    } catch (error) {
      if (error instanceof TunnelIpError) throw new UnprocessableEntityException(error.message);
      throw error;
    }
  }

  get tunnelNetwork(): TunnelNetwork {
    return this.network;
  }

  // ---------------------------------------------------------------------------------

  private joined(tx: TenantTransaction) {
    return tx
      .select(viewSelection)
      .from(routers)
      .innerJoin(sites, and(eq(sites.companyId, routers.companyId), eq(sites.id, routers.siteId)))
      .$dynamic();
  }

  private async insertManual(
    tx: TenantTransaction,
    ctx: TenantContext,
    input: RegisterRouterInput,
  ): Promise<string> {
    const tunnelIp = this.validTunnelIp(input.tunnelIp);
    const name = input.name.trim();
    if (name.length < 1 || name.length > 128) {
      throw new UnprocessableEntityException('Nom de routeur invalide');
    }
    this.assertCredentials(input.routerosUsername, input.routerosPassword);
    const fingerprint = input.tlsFingerprint?.toLowerCase().replace(/:/g, '') ?? null;
    if (fingerprint !== null && !FINGERPRINT.test(fingerprint)) {
      throw new UnprocessableEntityException(
        'Empreinte TLS invalide (SHA-256 hexadécimal attendu)',
      );
    }
    if (input.transport === 'REST_HTTPS' && !fingerprint) {
      throw new UnprocessableEntityException(
        'Le transport REST HTTPS exige l’empreinte TLS du routeur',
      );
    }
    const site = await this.site(tx, ctx, input.siteId);
    if (!site) throw new NotFoundException(SITE_NOT_FOUND);

    const id = await newId(tx);
    try {
      await tx.insert(routers).values({
        id,
        companyId: ctx.companyId,
        siteId: site.id,
        name,
        transport: input.transport,
        tunnelIp,
        routerosUsername: input.routerosUsername,
        routerosPasswordEncrypted: encryptRouterPassword(
          this.box,
          { companyId: ctx.companyId, routerId: id },
          input.routerosPassword,
        ),
        tlsFingerprint: fingerprint,
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictException('Adresse tunnel déjà attribuée à un autre routeur');
      }
      throw error;
    }
    return id;
  }

  private assertCredentials(username: string, password: string): void {
    if (!USERNAME.test(username))
      throw new UnprocessableEntityException('Nom du compte RouterOS invalide');
    if (password.length < 12 || password.length > 256) {
      throw new UnprocessableEntityException('Mot de passe RouterOS : 12 à 256 caractères');
    }
  }
}

/** Identifiant généré AVANT le chiffrement (AAD liée au routeur), dans la transaction. */
export async function newId(tx: TenantTransaction): Promise<string> {
  const generated = await tx.execute<{ id: string }>(sql`select uuidv7() as id`);
  const id = generated.rows[0]?.id;
  if (!id) throw new Error('uuidv7() indisponible');
  return id;
}
