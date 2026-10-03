import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  type CreateInvitationRequest,
  type ListMembersQuery,
  type Member,
  type Permission,
  type ResetMemberMfaRequest,
  type RoleAssignment,
} from '@ecsi/shared';
import { and, asc, desc, eq, inArray, isNotNull, isNull, ne } from 'drizzle-orm';
import { AuditService } from '../audit/audit.service.js';
import { diff } from '../audit/sanitize.js';
import { AuthService, INVITATION_TTL_MS } from '../auth/auth.service.js';
import type { AuthContext } from '../auth/auth.types.js';
import { generateOpaqueToken, hashToken } from '../auth/crypto/tokens.js';
import { MfaService } from '../auth/mfa.service.js';
import { SessionService } from '../auth/session.service.js';
import { AUTH_DRIZZLE, type Database } from '../database/database.module.js';
import {
  companies,
  invitationRoles,
  invitations,
  membershipRoleSites,
  membershipRoles,
  memberships,
  mfaFactors,
  rolePermissions,
  roles,
  sites,
  users,
} from '../database/schema/index.js';
import { AccessService, type Grants } from '../tenancy/access.service.js';
import {
  type TenantContext,
  TenantDatabase,
  type TenantTransaction,
} from '../tenancy/tenant-database.js';

const NOT_FOUND = 'Utilisateur introuvable';
const SUPERIOR = 'Ce membre détient des droits supérieurs aux vôtres';

/**
 * Membres, rôles et invitations de l'entreprise courante. Toutes les requêtes métier passent
 * par TenantDatabase (rôle ecsi_app, RLS) : company_id provient exclusivement de la session.
 *
 * Portée par site : un gestionnaire limité à certains sites ne voit et ne gère que les membres
 * dont TOUS les droits sont limités à des sites où il détient la permission concernée ; un
 * membre ayant une portée entreprise n'est visible que des gestionnaires à portée entreprise.
 * Un membre hors de la portée répond 404 (son existence n'est pas révélée).
 *
 * Anti-escalade : on n'agit sur un membre que si l'on détient chacune de ses permissions sur
 * la même portée (Grants.covers), et l'on n'attribue que des permissions détenues sur la
 * portée demandée (Grants.canGrant).
 */
@Injectable()
export class UsersService {
  constructor(
    private readonly tenantDb: TenantDatabase,
    private readonly access: AccessService,
    private readonly authService: AuthService,
    private readonly mfa: MfaService,
    private readonly sessions: SessionService,
    private readonly audit: AuditService,
    // Lectures complémentaires hors RLS, uniquement pour des membres déjà autorisés par la
    // requête tenant : 2FA activée (table de secrets) et appartenance à d'autres entreprises.
    @Inject(AUTH_DRIZZLE) private readonly authDb: Database,
  ) {}

  async listMembers(ctx: TenantContext, grants: Grants, query: ListMembersQuery = {}) {
    return this.tenantDb.run(ctx, async (tx) => {
      const all = await this.members(tx, ctx);
      const targets = await this.access.resolveMany(tx, ctx.companyId);
      const q = query.q?.toLowerCase();
      return all.filter((member) => {
        const target = targets.get(member.id);
        if (!target || !visible(grants, 'users.read', target)) return false;
        if (q && !`${member.fullName} ${member.email}`.toLowerCase().includes(q)) return false;
        if (query.status && member.status !== query.status) return false;
        if (query.roleId && !member.roles.some((role) => role.id === query.roleId)) return false;
        if (
          query.siteId &&
          !member.roles.some(
            (role) => role.scope === 'COMPANY' || role.sites.some((s) => s.id === query.siteId),
          )
        ) {
          return false;
        }
        return true;
      });
    });
  }

  async getMember(ctx: TenantContext, grants: Grants, userId: string): Promise<Member> {
    return this.tenantDb.run(ctx, async (tx) => {
      const { member } = await this.visibleMember(tx, ctx, grants, userId, 'users.read');
      return member;
    });
  }

  /** Active ou désactive un membre (effet immédiat : ses requêtes sont refusées). */
  async setMemberStatus(
    ctx: TenantContext,
    grants: Grants,
    userId: string,
    status: 'ACTIVE' | 'DISABLED',
  ): Promise<Member> {
    if (userId === ctx.userId) {
      throw new ForbiddenException('Vous ne pouvez pas modifier votre propre statut');
    }
    return this.tenantDb.run(ctx, async (tx) => {
      const { member, target } = await this.manageableMember(
        tx,
        ctx,
        grants,
        userId,
        'users.disable',
      );
      if (member.status === status) return member;
      if (status === 'DISABLED') await this.assertNotLastAdmin(tx, ctx, userId);
      await tx
        .update(memberships)
        .set({ status })
        .where(and(eq(memberships.companyId, ctx.companyId), eq(memberships.userId, userId)));
      await this.audit.write(tx, ctx.companyId, {
        action: status === 'DISABLED' ? 'users.disable' : 'users.enable',
        resourceType: 'user',
        resourceId: userId,
        siteId: singleSite(target),
        details: { member: member.email, status: { before: member.status, after: status } },
      });
      return { ...member, status };
    });
  }

  /** Remplace les rôles d'un membre ; ses sessions dans l'entreprise sont fermées. */
  async replaceRoles(
    ctx: TenantContext,
    grants: Grants,
    userId: string,
    assignments: RoleAssignment[],
  ): Promise<Member> {
    if (userId === ctx.userId) {
      throw new ForbiddenException('Vous ne pouvez pas modifier vos propres rôles');
    }
    const updated = await this.tenantDb.run(ctx, async (tx) => {
      const { member, target } = await this.manageableMember(
        tx,
        ctx,
        grants,
        userId,
        'users.update',
      );
      const resolved = await this.resolveAssignments(tx, ctx, grants, assignments, 'users.update');
      const [membership] = await tx
        .select({ id: memberships.id })
        .from(memberships)
        .where(and(eq(memberships.companyId, ctx.companyId), eq(memberships.userId, userId)));
      if (!membership) throw new NotFoundException(NOT_FOUND);

      await tx.delete(membershipRoles).where(eq(membershipRoles.membershipId, membership.id));
      await this.insertAssignments(tx, ctx.companyId, membership.id, resolved);
      await this.assertAdminRemains(tx, ctx);

      const [after] = await this.members(tx, ctx, userId);
      if (!after) throw new NotFoundException(NOT_FOUND);
      await this.audit.write(tx, ctx.companyId, {
        action: 'users.roles_update',
        resourceType: 'user',
        resourceId: userId,
        siteId: singleSite(target),
        details: {
          member: member.email,
          ...diff({ roles: describeRoles(member) }, { roles: describeRoles(after) }),
        },
      });
      return after;
    });
    // Changement de privilèges : nouvelle connexion (et 2FA si le nouveau rôle l'exige).
    await this.sessions.revokeForCompany(userId, ctx.companyId, 'ACCESS_REMOVED');
    return updated;
  }

  /** Retire l'accès d'un membre à l'entreprise (son compte reste valable ailleurs). */
  async removeMember(ctx: TenantContext, grants: Grants, userId: string): Promise<void> {
    if (userId === ctx.userId) {
      throw new ForbiddenException('Vous ne pouvez pas retirer votre propre accès');
    }
    await this.tenantDb.run(ctx, async (tx) => {
      const { member, target } = await this.manageableMember(
        tx,
        ctx,
        grants,
        userId,
        'users.remove',
      );
      await this.assertNotLastAdmin(tx, ctx, userId);
      await tx
        .delete(memberships)
        .where(and(eq(memberships.companyId, ctx.companyId), eq(memberships.userId, userId)));
      await this.audit.write(tx, ctx.companyId, {
        action: 'users.remove',
        resourceType: 'user',
        resourceId: userId,
        siteId: singleSite(target),
        details: { member: member.email, roles: describeRoles(member) },
      });
    });
    await this.sessions.revokeForCompany(userId, ctx.companyId, 'ACCESS_REMOVED');
  }

  /**
   * Récupération administrative de la 2FA d'un membre ayant perdu téléphone et codes :
   *  - permission users.mfa.reset sur le membre, anti-escalade, jamais sur soi-même ;
   *  - l'administrateur doit avoir une session vérifiée par 2FA et confirmer avec SON code ;
   *  - refusée si le membre appartient à une autre entreprise (la 2FA protège aussi cet
   *    autre accès) : la récupération revient alors à ECSI (console plateforme) ;
   *  - l'ancien secret est supprimé sans jamais être lu ; toutes les sessions du membre sont
   *    fermées ; l'opération est auditée et le membre est prévenu par e-mail.
   */
  async resetMfa(
    ctx: TenantContext,
    grants: Grants,
    auth: AuthContext,
    userId: string,
    input: ResetMemberMfaRequest,
  ): Promise<void> {
    if (userId === ctx.userId) {
      throw new ForbiddenException('Utilisez vos codes de récupération pour votre propre compte');
    }
    if (auth.mfaState !== 'VERIFIED') {
      throw new ForbiddenException(
        'Activez la double authentification sur votre compte avant cette opération',
      );
    }
    const { member } = await this.tenantDb.run(ctx, (tx) =>
      this.manageableMember(tx, ctx, grants, userId, 'users.mfa.reset'),
    );
    if (member.otherCompanies) {
      throw new ConflictException(
        'Ce compte appartient aussi à une autre entreprise : la récupération doit être faite par le support ECSI',
      );
    }
    if (!(await this.mfa.verify('user', ctx.userId, { code: input.code }))) {
      throw new UnprocessableEntityException('Votre code de vérification est invalide');
    }
    const existed = await this.mfa.reset('user', userId);
    const revoked = await this.sessions.revokeAll('user', userId, 'MFA_RESET');
    await this.tenantDb.run(ctx, (tx) =>
      this.audit.write(tx, ctx.companyId, {
        action: 'users.mfa_reset',
        resourceType: 'user',
        resourceId: userId,
        details: {
          member: member.email,
          reason: input.reason,
          hadMfa: existed,
          revokedSessions: revoked,
        },
      }),
    );
    const [actor] = await this.authDb
      .select({ fullName: users.fullName })
      .from(users)
      .where(eq(users.id, ctx.userId));
    const [target] = await this.authDb
      .select({ locale: users.locale })
      .from(users)
      .where(eq(users.id, userId));
    this.authService.sendMfaResetMail(
      member.email,
      actor?.fullName ?? 'un administrateur',
      target?.locale ?? 'fr',
    );
  }

  listRoles(ctx: TenantContext) {
    return this.tenantDb.run(ctx, async (tx) => {
      const rows = await tx
        .select({ id: roles.id, code: roles.code, name: roles.name, isSystem: roles.isSystem })
        .from(roles)
        .orderBy(asc(roles.name));
      const perms = await tx
        .select({ roleId: rolePermissions.roleId, code: rolePermissions.permissionCode })
        .from(rolePermissions);
      return rows.map((role) => ({
        ...role,
        permissions: perms
          .filter((p) => p.roleId === role.id)
          .map((p) => p.code)
          .sort(),
      }));
    });
  }

  listInvitations(ctx: TenantContext, grants: Grants) {
    return this.tenantDb.run(ctx, async (tx) => {
      const rows = await tx
        .select({
          id: invitations.id,
          email: invitations.email,
          status: invitations.status,
          expiresAt: invitations.expiresAt,
          createdAt: invitations.createdAt,
        })
        .from(invitations)
        .orderBy(desc(invitations.createdAt));
      const roleRows = rows.length
        ? await tx
            .select({
              invitationId: invitationRoles.invitationId,
              code: roles.code,
              name: roles.name,
              scope: invitationRoles.scope,
              siteIds: invitationRoles.siteIds,
            })
            .from(invitationRoles)
            .innerJoin(roles, eq(roles.id, invitationRoles.roleId))
            .where(
              inArray(
                invitationRoles.invitationId,
                rows.map((row) => row.id),
              ),
            )
        : [];
      return rows
        .map((row) => ({
          id: row.id,
          email: row.email,
          status: row.status,
          expired: row.status === 'PENDING' && row.expiresAt.getTime() <= Date.now(),
          expiresAt: row.expiresAt.toISOString(),
          createdAt: row.createdAt.toISOString(),
          roles: roleRows
            .filter((r) => r.invitationId === row.id)
            .map(({ code, name, scope, siteIds }) => ({ code, name, scope, siteIds })),
        }))
        .filter((invitation) => invitationVisible(grants, 'users.read', invitation.roles));
    });
  }

  async createInvitation(ctx: TenantContext, grants: Grants, input: CreateInvitationRequest) {
    const token = generateOpaqueToken();
    const result = await this.tenantDb.run(ctx, async (tx) => {
      const resolved = await this.resolveAssignments(tx, ctx, grants, input.roles, 'users.invite');

      const [member] = await tx
        .select({ id: memberships.id })
        .from(memberships)
        .innerJoin(users, eq(users.id, memberships.userId))
        .where(eq(users.email, input.email));
      if (member) throw new ConflictException('Cette personne est déjà membre de l’entreprise');

      let invitationId: string;
      try {
        const [invitation] = await tx
          .insert(invitations)
          .values({
            companyId: ctx.companyId,
            email: input.email,
            tokenHash: hashToken(token),
            invitedByUserId: ctx.userId,
            expiresAt: new Date(Date.now() + INVITATION_TTL_MS),
          })
          .returning({ id: invitations.id });
        if (!invitation) throw new Error('Création de l’invitation impossible');
        invitationId = invitation.id;
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new ConflictException('Une invitation est déjà en attente pour cette adresse');
        }
        throw error;
      }
      await tx.insert(invitationRoles).values(
        resolved.map((role) => ({
          companyId: ctx.companyId,
          invitationId,
          roleId: role.roleId,
          scope: role.scope,
          siteIds: role.siteIds,
        })),
      );
      const [company] = await tx.select({ name: companies.name }).from(companies);
      const [inviter] = await tx
        .select({ fullName: users.fullName })
        .from(users)
        .where(eq(users.id, ctx.userId));
      await this.audit.write(tx, ctx.companyId, {
        action: 'invitations.create',
        resourceType: 'invitation',
        resourceId: invitationId,
        siteId:
          resolved.length === 1 && resolved[0]?.siteIds.length === 1
            ? resolved[0].siteIds[0]
            : null,
        details: {
          email: input.email,
          roles: resolved.map((role) => ({
            role: role.code,
            scope: role.scope,
            siteIds: role.siteIds,
          })),
        },
      });
      return {
        invitationId,
        companyName: company?.name ?? '',
        inviterName: inviter?.fullName ?? '',
      };
    });

    this.authService.sendInvitationMail(input.email, token, result.companyName, result.inviterName);
    return { id: result.invitationId };
  }

  async revokeInvitation(ctx: TenantContext, grants: Grants, invitationId: string): Promise<void> {
    await this.tenantDb.run(ctx, async (tx) => {
      const [invitation] = await tx
        .select({ id: invitations.id, email: invitations.email })
        .from(invitations)
        .where(and(eq(invitations.id, invitationId), eq(invitations.status, 'PENDING')));
      if (!invitation) throw new NotFoundException('Invitation introuvable');
      const roleRows = await tx
        .select({ scope: invitationRoles.scope, siteIds: invitationRoles.siteIds })
        .from(invitationRoles)
        .where(eq(invitationRoles.invitationId, invitationId));
      if (!invitationVisible(grants, 'users.invite', roleRows)) {
        throw new NotFoundException('Invitation introuvable');
      }
      await tx
        .update(invitations)
        .set({ status: 'REVOKED' })
        .where(eq(invitations.id, invitationId));
      await this.audit.write(tx, ctx.companyId, {
        action: 'invitations.revoke',
        resourceType: 'invitation',
        resourceId: invitationId,
        details: { email: invitation.email },
      });
    });
  }

  // ---------------------------------------------------------------------------

  /** Membre visible pour la permission donnée, sinon 404. */
  private async visibleMember(
    tx: TenantTransaction,
    ctx: TenantContext,
    grants: Grants,
    userId: string,
    permission: Permission,
  ): Promise<{ member: Member; target: Grants }> {
    const [member] = await this.members(tx, ctx, userId);
    if (!member) throw new NotFoundException(NOT_FOUND);
    const target = (await this.access.resolveMany(tx, ctx.companyId, [userId])).get(userId);
    if (!target || !visible(grants, permission, target)) throw new NotFoundException(NOT_FOUND);
    return { member, target };
  }

  /** Membre visible ET gérable (permission sur sa portée, droits couverts), sinon 404/403. */
  private async manageableMember(
    tx: TenantTransaction,
    ctx: TenantContext,
    grants: Grants,
    userId: string,
    permission: Permission,
  ) {
    const found = await this.visibleMember(tx, ctx, grants, userId, 'users.read');
    if (!grants.hasOverMember(permission, found.target)) {
      throw new ForbiddenException("Vous n'avez pas la permission d'effectuer cette action");
    }
    if (!grants.covers(found.target)) throw new ForbiddenException(SUPERIOR);
    return found;
  }

  /**
   * Vérifie des attributions de rôles demandées : rôles de l'entreprise, sites existants de
   * l'entreprise, permission d'action et anti-escalade sur la portée demandée.
   */
  private async resolveAssignments(
    tx: TenantTransaction,
    ctx: TenantContext,
    grants: Grants,
    assignments: RoleAssignment[],
    permission: Permission,
  ) {
    const roleIds = [...new Set(assignments.map((role) => role.roleId))];
    if (roleIds.length !== assignments.length) {
      throw new UnprocessableEntityException('Un rôle ne peut être attribué qu’une fois');
    }
    const found = await tx
      .select({ id: roles.id, code: roles.code })
      .from(roles)
      .where(and(eq(roles.companyId, ctx.companyId), inArray(roles.id, roleIds)));
    if (found.length !== roleIds.length) throw new UnprocessableEntityException('Rôle inconnu');

    const siteIds = [...new Set(assignments.flatMap((role) => role.siteIds))];
    if (siteIds.length > 0) {
      const existing = await tx
        .select({ id: sites.id })
        .from(sites)
        .where(
          and(
            eq(sites.companyId, ctx.companyId),
            inArray(sites.id, siteIds),
            isNull(sites.deletedAt),
          ),
        );
      if (existing.length !== siteIds.length) {
        // Même réponse pour un site d'une autre entreprise et un site inexistant.
        throw new UnprocessableEntityException('Site inconnu');
      }
    }

    const perms = await tx
      .select({ roleId: rolePermissions.roleId, code: rolePermissions.permissionCode })
      .from(rolePermissions)
      .where(inArray(rolePermissions.roleId, roleIds));

    return assignments.map((assignment) => {
      const scopeAllowed =
        assignment.scope === 'COMPANY'
          ? grants.hasCompanyWide(permission)
          : assignment.siteIds.every((site) => grants.hasForSite(permission, site));
      if (!scopeAllowed) {
        throw new ForbiddenException(
          assignment.scope === 'COMPANY'
            ? 'Seul un gestionnaire de toute l’entreprise peut attribuer un rôle à l’échelle de l’entreprise'
            : 'Vous ne gérez pas tous les sites demandés',
        );
      }
      const rolePerms = perms.filter((p) => p.roleId === assignment.roleId).map((p) => p.code);
      if (!grants.canGrant(rolePerms, assignment.scope, assignment.siteIds)) {
        throw new ForbiddenException(
          'Vous ne pouvez pas attribuer des droits que vous ne détenez pas',
        );
      }
      const code = found.find((role) => role.id === assignment.roleId)?.code ?? '';
      return { ...assignment, code };
    });
  }

  private async insertAssignments(
    tx: TenantTransaction,
    companyId: string,
    membershipId: string,
    assignments: (RoleAssignment & { code: string })[],
  ): Promise<void> {
    for (const assignment of assignments) {
      const [row] = await tx
        .insert(membershipRoles)
        .values({ companyId, membershipId, roleId: assignment.roleId, scope: assignment.scope })
        .returning({ id: membershipRoles.id });
      if (row && assignment.scope === 'SITES') {
        await tx
          .insert(membershipRoleSites)
          .values(
            assignment.siteIds.map((siteId) => ({ companyId, membershipRoleId: row.id, siteId })),
          );
      }
    }
  }

  /** L'entreprise doit toujours garder au moins un administrateur actif à portée entreprise. */
  private async assertNotLastAdmin(tx: TenantTransaction, ctx: TenantContext, userId: string) {
    const admins = await this.activeAdmins(tx, ctx);
    if (admins.length === 1 && admins[0] === userId) {
      throw new ConflictException("L'entreprise doit conserver au moins un administrateur actif");
    }
  }

  private async assertAdminRemains(tx: TenantTransaction, ctx: TenantContext) {
    if ((await this.activeAdmins(tx, ctx)).length === 0) {
      throw new ConflictException("L'entreprise doit conserver au moins un administrateur actif");
    }
  }

  private async activeAdmins(tx: TenantTransaction, ctx: TenantContext): Promise<string[]> {
    const rows = await tx
      .select({ userId: memberships.userId })
      .from(membershipRoles)
      .innerJoin(memberships, eq(memberships.id, membershipRoles.membershipId))
      .innerJoin(roles, eq(roles.id, membershipRoles.roleId))
      .where(
        and(
          eq(memberships.companyId, ctx.companyId),
          eq(memberships.status, 'ACTIVE'),
          eq(roles.code, 'ADMIN_ENTREPRISE'),
          eq(roles.isSystem, true),
          eq(membershipRoles.scope, 'COMPANY'),
        ),
      );
    return [...new Set(rows.map((row) => row.userId))];
  }

  // Filtre explicite sur l'entreprise EN PLUS de la RLS (défense en profondeur).
  private async members(
    tx: TenantTransaction,
    ctx: TenantContext,
    userId?: string,
  ): Promise<Member[]> {
    const rows = await tx
      .select({
        membershipId: memberships.id,
        userId: users.id,
        email: users.email,
        fullName: users.fullName,
        status: memberships.status,
        lastLoginAt: users.lastLoginAt,
        joinedAt: memberships.createdAt,
      })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(
        and(
          eq(memberships.companyId, ctx.companyId),
          userId ? eq(memberships.userId, userId) : undefined,
        ),
      )
      .orderBy(asc(users.fullName));
    if (rows.length === 0) return [];
    const membershipIds = rows.map((row) => row.membershipId);
    const assigned = await tx
      .select({
        assignmentId: membershipRoles.id,
        membershipId: membershipRoles.membershipId,
        id: roles.id,
        code: roles.code,
        name: roles.name,
        scope: membershipRoles.scope,
      })
      .from(membershipRoles)
      .innerJoin(roles, eq(roles.id, membershipRoles.roleId))
      .where(inArray(membershipRoles.membershipId, membershipIds));
    const siteRows = assigned.length
      ? await tx
          .select({
            assignmentId: membershipRoleSites.membershipRoleId,
            id: sites.id,
            name: sites.name,
            code: sites.code,
          })
          .from(membershipRoleSites)
          .innerJoin(sites, eq(sites.id, membershipRoleSites.siteId))
          .where(
            inArray(
              membershipRoleSites.membershipRoleId,
              assigned.map((a) => a.assignmentId),
            ),
          )
      : [];

    const userIds = rows.map((row) => row.userId);
    const mfaEnabled = new Set(
      (
        await this.authDb
          .select({ userId: mfaFactors.userId })
          .from(mfaFactors)
          .where(and(inArray(mfaFactors.userId, userIds), isNotNull(mfaFactors.confirmedAt)))
      ).map((row) => row.userId),
    );
    const elsewhere = new Set(
      (
        await this.authDb
          .select({ userId: memberships.userId })
          .from(memberships)
          .where(
            and(inArray(memberships.userId, userIds), ne(memberships.companyId, ctx.companyId)),
          )
      ).map((row) => row.userId),
    );

    return rows.map((row) => ({
      id: row.userId,
      email: row.email,
      fullName: row.fullName,
      status: row.status as Member['status'],
      joinedAt: row.joinedAt.toISOString(),
      lastLoginAt: row.lastLoginAt?.toISOString() ?? null,
      mfaEnabled: mfaEnabled.has(row.userId),
      otherCompanies: elsewhere.has(row.userId),
      roles: assigned
        .filter((role) => role.membershipId === row.membershipId)
        .map((role) => ({
          id: role.id,
          code: role.code,
          name: role.name,
          scope: role.scope as 'COMPANY' | 'SITES',
          sites: siteRows
            .filter((site) => site.assignmentId === role.assignmentId)
            .map(({ id, name, code }) => ({ id, name, code })),
        })),
    }));
  }
}

/** Le membre est visible pour la permission : portée entreprise, ou tous ses sites couverts. */
function visible(grants: Grants, permission: Permission, target: Grants): boolean {
  if (grants.hasCompanyWide(permission)) return true;
  if (target.companyWide.size > 0 || target.bySite.size === 0) return false;
  return [...target.bySite.keys()].every((site) => grants.hasForSite(permission, site));
}

function invitationVisible(
  grants: Grants,
  permission: Permission,
  invitationRolesList: readonly { scope: string; siteIds: readonly string[] }[],
): boolean {
  if (grants.hasCompanyWide(permission)) return true;
  return (
    invitationRolesList.length > 0 &&
    invitationRolesList.every(
      (role) =>
        role.scope === 'SITES' && role.siteIds.every((site) => grants.hasForSite(permission, site)),
    )
  );
}

/** Site du membre s'il n'intervient que sur un seul site (filtre « site » du journal). */
function singleSite(target: Grants): string | null {
  const keys = [...target.bySite.keys()];
  return target.companyWide.size === 0 && keys.length === 1 ? (keys[0] ?? null) : null;
}

function describeRoles(member: Member): string[] {
  return member.roles
    .map((role) =>
      role.scope === 'COMPANY'
        ? `${role.code} (entreprise)`
        : `${role.code} (${role.sites.map((site) => site.code).join(', ')})`,
    )
    .sort();
}

function isUniqueViolation(error: unknown): boolean {
  const cause = (error as { cause?: { code?: string }; code?: string } | undefined) ?? {};
  return cause.code === '23505' || cause.cause?.code === '23505';
}
