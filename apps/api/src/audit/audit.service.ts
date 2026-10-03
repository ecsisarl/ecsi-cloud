import { Inject, Injectable, Logger } from '@nestjs/common';
import type { AuditActorType, AuditResult } from '@ecsi/shared';
import { eq } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import { currentRequest, requestInfo } from '../common/request-context.js';
import { AUTH_DRIZZLE, type Database } from '../database/database.module.js';
import { auditEvents, platformAdmins, users } from '../database/schema/index.js';
import type { TenantTransaction } from '../tenancy/tenant-database.js';
import { sanitizeRecord } from './sanitize.js';

export interface AuditEntry {
  /** « ressource.action », ex. « sites.create », « auth.login ». */
  action: string;
  resourceType: string;
  resourceId?: string | null;
  siteId?: string | null;
  result?: AuditResult;
  /** Avant/après et précisions : nettoyés de tout secret avant écriture. */
  details?: Record<string, unknown>;
}

export interface AuditActor {
  type: AuditActorType;
  id: string | null;
  label?: string | null;
  roles?: readonly string[];
}

declare module 'fastify' {
  interface FastifyRequest {
    /** Un événement d'audit de succès a été écrit pendant la requête. */
    auditWritten?: boolean;
    auditActorLabel?: string | null;
  }
}

/**
 * Écriture du journal d'audit. Deux chemins :
 *  - write(tx, …) : dans la transaction tenant de l'opération (rôle ecsi_app). L'événement
 *    est atomique avec la modification : si elle échoue, il n'existe pas ; s'il ne peut pas
 *    être écrit, la modification est annulée. La RLS impose entreprise = contexte et
 *    acteur = utilisateur authentifié.
 *  - writeDirect(…) : rôle ecsi_auth, pour les événements sans tenant (connexion, plateforme)
 *    et les échecs (la transaction métier a été annulée).
 * Le chaînage par hachage et l'horodatage sont calculés par PostgreSQL (migration 0004).
 */
@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(@Inject(AUTH_DRIZZLE) private readonly authDb: Database) {}

  async write(tx: TenantTransaction, companyId: string, entry: AuditEntry): Promise<void> {
    const request = currentRequest();
    const auth = request?.auth;
    if (auth?.realm !== 'user') throw new Error('Audit tenant sans utilisateur authentifié');
    const label = await this.userLabel(request, auth.principalId, tx);
    await tx.insert(auditEvents).values(
      this.row(companyId, entry, {
        type: 'USER',
        id: auth.principalId,
        label,
        roles: request?.grants?.roles ?? [],
      }),
    );
    if (request && (entry.result ?? 'SUCCESS') === 'SUCCESS') request.auditWritten = true;
  }

  /**
   * Écriture dans une transaction ecsi_auth en cours (console plateforme) : l'événement est
   * atomique avec l'opération. L'acteur est celui de la requête (super administrateur).
   */
  async writeIn(tx: Pick<Database, 'insert'>, companyId: string | null, entry: AuditEntry) {
    const request = currentRequest();
    const actor = await this.actorFromRequest(request);
    await tx.insert(auditEvents).values(this.row(companyId, entry, actor, request));
    if (request && (entry.result ?? 'SUCCESS') === 'SUCCESS') request.auditWritten = true;
  }

  /** Écriture hors transaction tenant (ecsi_auth). Une erreur est journalisée puis propagée. */
  async writeDirect(
    companyId: string | null,
    entry: AuditEntry,
    actor?: AuditActor,
    request: FastifyRequest | undefined = currentRequest(),
  ): Promise<void> {
    try {
      const resolved = actor ?? (await this.actorFromRequest(request));
      await this.authDb.insert(auditEvents).values(this.row(companyId, entry, resolved, request));
      if (request && (entry.result ?? 'SUCCESS') === 'SUCCESS') request.auditWritten = true;
    } catch (error) {
      // Un échec d'écriture du journal est grave mais ne doit pas masquer l'erreur d'origine.
      this.logger.error(
        { err: error, action: entry.action, requestId: request?.id },
        "Écriture du journal d'audit impossible",
      );
      throw error;
    }
  }

  private row(
    companyId: string | null,
    entry: AuditEntry,
    actor: AuditActor,
    request: FastifyRequest | undefined = currentRequest(),
  ) {
    const info = requestInfo(request);
    return {
      companyId,
      // Valeurs provisoires : écrasées par le déclencheur de chaînage.
      chainKey: companyId ?? 'platform',
      chainSeq: 0,
      hash: Buffer.alloc(0),
      actorType: actor.type,
      actorId: actor.id,
      actorLabel: actor.label ?? null,
      actorRoles: [...(actor.roles ?? [])],
      action: entry.action,
      resourceType: entry.resourceType,
      resourceId: entry.resourceId ?? null,
      siteId: entry.siteId ?? null,
      result: entry.result ?? 'SUCCESS',
      ip: info.ip,
      userAgent: info.userAgent,
      requestId: info.requestId,
      details: sanitizeRecord(entry.details),
    };
  }

  /** Acteur de la requête courante (utilisateur, super administrateur ou anonyme). */
  async actorFromRequest(request = currentRequest()): Promise<AuditActor> {
    const auth = request?.auth;
    if (!auth) return { type: 'ANONYMOUS', id: null };
    if (auth.realm === 'platform') {
      return {
        type: 'PLATFORM_ADMIN',
        id: auth.principalId,
        label: await this.platformLabel(request, auth.principalId),
        roles: ['SUPER_ADMIN'],
      };
    }
    return {
      type: 'USER',
      id: auth.principalId,
      label: await this.userLabel(request, auth.principalId),
      roles: request.grants?.roles ?? [],
    };
  }

  /** Acteur désigné explicitement (flux de connexion, avant toute session). */
  async principal(realm: 'user' | 'platform', id: string): Promise<AuditActor> {
    return realm === 'platform'
      ? {
          type: 'PLATFORM_ADMIN',
          id,
          label: await this.platformLabel(undefined, id),
          roles: ['SUPER_ADMIN'],
        }
      : { type: 'USER', id, label: await this.userLabel(undefined, id) };
  }

  private async userLabel(
    request: FastifyRequest | undefined,
    userId: string,
    tx?: TenantTransaction,
  ): Promise<string | null> {
    if (request?.auditActorLabel !== undefined) return request.auditActorLabel;
    const db = tx ?? this.authDb;
    const [user] = await db
      .select({ fullName: users.fullName, email: users.email })
      .from(users)
      .where(eq(users.id, userId));
    const label = user ? `${user.fullName} <${user.email}>` : null;
    if (request) request.auditActorLabel = label;
    return label;
  }

  private async platformLabel(
    request: FastifyRequest | undefined,
    adminId: string,
  ): Promise<string | null> {
    if (request?.auditActorLabel !== undefined) return request.auditActorLabel;
    const [admin] = await this.authDb
      .select({ fullName: platformAdmins.fullName, email: platformAdmins.email })
      .from(platformAdmins)
      .where(eq(platformAdmins.id, adminId));
    const label = admin ? `${admin.fullName} <${admin.email}> (ECSI)` : null;
    if (request) request.auditActorLabel = label;
    return label;
  }
}
