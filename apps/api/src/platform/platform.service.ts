import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  type CreateCompanyRequest,
  type ListAuditQuery,
  type ListPlatformCompaniesQuery,
  type PlatformCompanyDetail,
  type PlatformCompanyPage,
  type PlatformUser,
  type ResetMemberMfaRequest,
  type SetCompanyStatusRequest,
  slugify,
} from '@ecsi/shared';
import { and, asc, count, desc, eq, ilike, inArray, isNull, or, type SQL, sql } from 'drizzle-orm';
import { getAuditEvent, listAuditEvents } from '../audit/audit-query.js';
import { AuditService } from '../audit/audit.service.js';
import { AuthService, INVITATION_TTL_MS } from '../auth/auth.service.js';
import type { AuthContext } from '../auth/auth.types.js';
import { generateOpaqueToken, hashToken } from '../auth/crypto/tokens.js';
import { MfaService } from '../auth/mfa.service.js';
import { SessionService } from '../auth/session.service.js';
import { toCompanyProfile } from '../companies/companies.service.js';
import { ensureSystemRoles } from '../database/catalog.js';
import { AUTH_DRIZZLE, type Database } from '../database/database.module.js';
import {
  auditEvents,
  companies,
  invitationRoles,
  invitations,
  memberships,
  membershipRoles,
  mfaFactors,
  roles,
  sites,
  users,
} from '../database/schema/index.js';

/**
 * Console des super administrateurs ECSI (domaine plateforme).
 *
 * Elle n'utilise JAMAIS le contexte tenant : pas de TenantDatabase, pas de permissions
 * d'entreprise. Elle passe par le rôle ecsi_auth (sans tenant), dont les privilèges sur
 * companies, roles, invitations… ont été accordés précisément pour ces opérations
 * (migration 0004, ADR 0013). Inversement, une session plateforme est refusée sur toutes les
 * routes d'entreprise (AuthGuard) : les deux domaines restent séparés.
 *
 * Chaque action est auditée dans la même transaction que l'opération : chaîne de
 * l'entreprise visée (visible de ses administrateurs) ou chaîne « platform ».
 */
@Injectable()
export class PlatformService {
  constructor(
    @Inject(AUTH_DRIZZLE) private readonly db: Database,
    private readonly audit: AuditService,
    private readonly authService: AuthService,
    private readonly mfa: MfaService,
    private readonly sessions: SessionService,
  ) {}

  async listCompanies(query: ListPlatformCompaniesQuery): Promise<PlatformCompanyPage> {
    const filters: (SQL | undefined)[] = [
      query.status ? eq(companies.status, query.status) : undefined,
    ];
    if (query.q) {
      const pattern = `%${escapeLike(query.q)}%`;
      filters.push(
        or(
          ilike(companies.name, pattern),
          ilike(companies.slug, pattern),
          ilike(companies.legalName, pattern),
          ilike(companies.email, pattern),
        ),
      );
    }
    const where = and(...filters);
    const [total] = await this.db.select({ value: count() }).from(companies).where(where);
    const rows = await this.db
      .select({
        id: companies.id,
        name: companies.name,
        slug: companies.slug,
        country: companies.country,
        currency: companies.currency,
        status: companies.status,
        createdAt: companies.createdAt,
        // Sous-requêtes corrélées : la colonne externe est qualifiée explicitement (drizzle
        // n'écrit pas le nom de table quand la requête ne porte que sur une table).
        memberCount: sql<number>`(select count(*)::int from memberships m where m.company_id = "companies"."id")`,
        siteCount: sql<number>`(select count(*)::int from sites s where s.company_id = "companies"."id" and s.deleted_at is null)`,
      })
      .from(companies)
      .where(where)
      .orderBy(desc(companies.createdAt), asc(companies.id))
      .limit(query.limit)
      .offset((query.page - 1) * query.limit);
    return {
      data: rows.map((row) => ({
        ...row,
        status: row.status as 'ACTIVE' | 'SUSPENDED',
        createdAt: row.createdAt.toISOString(),
      })),
      total: total?.value ?? 0,
      page: query.page,
      limit: query.limit,
    };
  }

  async getCompany(id: string): Promise<PlatformCompanyDetail> {
    const [row] = await this.db.select().from(companies).where(eq(companies.id, id));
    if (!row) throw new NotFoundException('Entreprise introuvable');
    const [[memberCount], [siteCount], [pending], admins] = await Promise.all([
      this.db.select({ value: count() }).from(memberships).where(eq(memberships.companyId, id)),
      this.db
        .select({ value: count() })
        .from(sites)
        .where(and(eq(sites.companyId, id), isNull(sites.deletedAt))),
      this.db
        .select({ value: count() })
        .from(invitations)
        .where(and(eq(invitations.companyId, id), eq(invitations.status, 'PENDING'))),
      this.db
        .selectDistinct({ id: users.id, fullName: users.fullName, email: users.email })
        .from(membershipRoles)
        .innerJoin(roles, eq(roles.id, membershipRoles.roleId))
        .innerJoin(memberships, eq(memberships.id, membershipRoles.membershipId))
        .innerJoin(users, eq(users.id, memberships.userId))
        .where(
          and(
            eq(membershipRoles.companyId, id),
            eq(roles.code, 'ADMIN_ENTREPRISE'),
            eq(memberships.status, 'ACTIVE'),
          ),
        ),
    ]);
    return {
      ...toCompanyProfile(row),
      memberCount: memberCount?.value ?? 0,
      siteCount: siteCount?.value ?? 0,
      pendingInvitations: pending?.value ?? 0,
      suspendedAt: row.suspendedAt?.toISOString() ?? null,
      suspensionReason: row.suspensionReason,
      admins,
    };
  }

  /**
   * Crée l'entreprise, ses rôles système et invite son premier administrateur
   * (ADMIN_ENTREPRISE, toute l'entreprise). Aucun mot de passe n'est choisi par ECSI :
   * l'administrateur définit le sien en acceptant l'invitation.
   */
  async createCompany(input: CreateCompanyRequest): Promise<PlatformCompanyDetail> {
    const slug = input.slug ?? slugify(input.name);
    if (slug.length < 2) {
      throw new UnprocessableEntityException('Indiquez un identifiant (slug) valide');
    }
    const token = generateOpaqueToken();
    let companyId: string;
    try {
      companyId = await this.db.transaction(async (tx) => {
        const [company] = await tx
          .insert(companies)
          .values({
            name: input.name,
            slug,
            legalName: input.legalName ?? null,
            country: input.country,
            currency: input.currency,
            locale: input.locale,
            timezone: input.timezone,
          })
          .returning({ id: companies.id });
        if (!company) throw new Error("Création de l'entreprise impossible");
        const roleIds = await ensureSystemRoles(tx, company.id);
        const adminRoleId = roleIds.ADMIN_ENTREPRISE;
        if (!adminRoleId) throw new Error('Rôle ADMIN_ENTREPRISE introuvable');
        const [invitation] = await tx
          .insert(invitations)
          .values({
            companyId: company.id,
            email: input.adminEmail,
            tokenHash: hashToken(token),
            invitedByUserId: null,
            expiresAt: new Date(Date.now() + INVITATION_TTL_MS),
          })
          .returning({ id: invitations.id });
        if (!invitation) throw new Error("Création de l'invitation impossible");
        await tx.insert(invitationRoles).values({
          companyId: company.id,
          invitationId: invitation.id,
          roleId: adminRoleId,
          scope: 'COMPANY',
          siteIds: [],
        });
        await this.audit.writeIn(tx, company.id, {
          action: 'platform.companies.create',
          resourceType: 'company',
          resourceId: company.id,
          details: {
            name: input.name,
            slug,
            country: input.country,
            currency: input.currency,
            adminEmail: input.adminEmail,
            invitationId: invitation.id,
          },
        });
        return company.id;
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictException('Cet identifiant (slug) est déjà utilisé');
      }
      throw error;
    }
    this.authService.sendInvitationMail(input.adminEmail, token, input.name, "L'équipe ECSI");
    return this.getCompany(companyId);
  }

  /**
   * Suspension / réactivation. Une entreprise suspendue est refusée à chaque requête
   * (SessionService.loadContext) ; ses sessions sont en plus révoquées immédiatement.
   */
  async setCompanyStatus(id: string, input: SetCompanyStatusRequest) {
    const result = await this.db.transaction(async (tx) => {
      const [before] = await tx
        .select({ status: companies.status, name: companies.name })
        .from(companies)
        .where(eq(companies.id, id))
        .for('update');
      if (!before) throw new NotFoundException('Entreprise introuvable');
      if (before.status === input.status) {
        throw new ConflictException(
          input.status === 'SUSPENDED'
            ? "L'entreprise est déjà suspendue"
            : "L'entreprise est déjà active",
        );
      }
      const suspend = input.status === 'SUSPENDED';
      await tx
        .update(companies)
        .set({
          status: input.status,
          suspendedAt: suspend ? new Date() : null,
          suspensionReason: suspend ? input.reason : null,
        })
        .where(eq(companies.id, id));
      await this.audit.writeIn(tx, id, {
        action: suspend ? 'platform.companies.suspend' : 'platform.companies.reactivate',
        resourceType: 'company',
        resourceId: id,
        details: { before: before.status, after: input.status, reason: input.reason },
      });
      return { suspend };
    });
    if (result.suspend) await this.sessions.revokeAllForCompany(id, 'COMPANY_SUSPENDED');
    return this.getCompany(id);
  }

  /** Recherche d'un compte utilisateur (support : récupération de la 2FA). */
  async searchUsers(q: string): Promise<PlatformUser[]> {
    const pattern = `%${escapeLike(q)}%`;
    const rows = await this.db
      .select({
        id: users.id,
        email: users.email,
        fullName: users.fullName,
        status: users.status,
      })
      .from(users)
      .where(
        and(
          isNull(users.deletedAt),
          or(ilike(users.email, pattern), ilike(users.fullName, pattern)),
        ),
      )
      .orderBy(asc(users.email))
      .limit(20);
    if (rows.length === 0) return [];
    const ids = rows.map((row) => row.id);
    const [factors, links] = await Promise.all([
      this.db
        .select({ userId: mfaFactors.userId })
        .from(mfaFactors)
        .where(and(inArray(mfaFactors.userId, ids), sql`${mfaFactors.confirmedAt} is not null`)),
      this.db
        .select({ userId: memberships.userId, id: companies.id, name: companies.name })
        .from(memberships)
        .innerJoin(companies, eq(companies.id, memberships.companyId))
        .where(inArray(memberships.userId, ids)),
    ]);
    const withMfa = new Set(factors.map((factor) => factor.userId));
    return rows.map((row) => ({
      ...row,
      mfaEnabled: withMfa.has(row.id),
      companies: links
        .filter((link) => link.userId === row.id)
        .map((link) => ({ id: link.id, name: link.name })),
    }));
  }

  /**
   * Récupération de la 2FA d'un utilisateur par le support ECSI (cas des comptes présents
   * dans plusieurs entreprises, que l'administrateur d'une entreprise ne peut pas traiter).
   * Le super administrateur confirme avec son propre code TOTP ; l'ancien secret est
   * supprimé, jamais révélé ; toutes les sessions de l'utilisateur sont révoquées.
   */
  async resetUserMfa(auth: AuthContext, userId: string, input: ResetMemberMfaRequest) {
    if (auth.mfaState !== 'VERIFIED') {
      throw new ForbiddenException('Session sans double authentification vérifiée');
    }
    const [target] = await this.db
      .select({ id: users.id, email: users.email, locale: users.locale })
      .from(users)
      .where(and(eq(users.id, userId), isNull(users.deletedAt)));
    if (!target) throw new NotFoundException('Utilisateur introuvable');
    if (!(await this.mfa.verify('platform', auth.principalId, { code: input.code }))) {
      throw new UnprocessableEntityException('Votre code de vérification est invalide');
    }
    const existed = await this.mfa.reset('user', userId);
    const revoked = await this.sessions.revokeAll('user', userId, 'MFA_RESET');
    const companyIds = (
      await this.db
        .select({ companyId: memberships.companyId })
        .from(memberships)
        .where(eq(memberships.userId, userId))
    ).map((row) => row.companyId);
    await this.db.transaction(async (tx) => {
      const entry = {
        action: 'platform.users.mfa_reset',
        resourceType: 'user',
        resourceId: userId,
        details: {
          member: target.email,
          reason: input.reason,
          hadMfa: existed,
          revokedSessions: revoked,
        },
      };
      await this.audit.writeIn(tx, null, entry);
      // Les entreprises du compte voient aussi l'intervention dans leur propre journal.
      for (const companyId of companyIds) await this.audit.writeIn(tx, companyId, entry);
    });
    this.authService.sendMfaResetMail(target.email, 'le support ECSI', target.locale);
  }

  listAudit(query: ListAuditQuery, companyId?: string) {
    return listAuditEvents(this.db, query, companyId, { withCompanyName: true });
  }

  getAuditEvent(id: string) {
    return getAuditEvent(this.db, id, undefined);
  }

  /** Vérification d'intégrité d'une chaîne d'audit (« platform » ou identifiant d'entreprise). */
  async verifyAuditChain(chainKey: string) {
    const broken = await this.db.execute<{ chain_seq: string | number }>(
      sql`select chain_seq from app.audit_verify_chain(${chainKey}) limit 100`,
    );
    const [checked] = await this.db
      .select({ value: count() })
      .from(auditEvents)
      .where(eq(auditEvents.chainKey, chainKey));
    const brokenSeqs = broken.rows.map((row) => Number(row.chain_seq));
    return { chainKey, checked: checked?.value ?? 0, valid: brokenSeqs.length === 0, brokenSeqs };
  }
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

function isUniqueViolation(error: unknown): boolean {
  const cause = (error as { cause?: { code?: string }; code?: string } | undefined) ?? {};
  return cause.code === '23505' || cause.cause?.code === '23505';
}
