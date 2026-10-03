import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { CreateInvitationRequest } from '@ecsi/shared';
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { AuthService, INVITATION_TTL_MS } from '../auth/auth.service.js';
import { generateOpaqueToken, hashToken } from '../auth/crypto/tokens.js';
import {
  companies,
  invitationRoles,
  invitations,
  membershipRoles,
  memberships,
  rolePermissions,
  roles,
  users,
} from '../database/schema/index.js';
import { AccessService, type Grants } from '../tenancy/access.service.js';
import {
  type TenantContext,
  TenantDatabase,
  type TenantTransaction,
} from '../tenancy/tenant-database.js';

export interface MemberView {
  id: string;
  email: string;
  fullName: string;
  status: string;
  roles: { id: string; code: string; name: string; scope: string }[];
  joinedAt: string;
}

/**
 * Membres, invitations et rôles de l'entreprise courante. Toutes les requêtes passent par
 * TenantDatabase (rôle ecsi_app, RLS) : company_id provient exclusivement de la session.
 */
@Injectable()
export class UsersService {
  constructor(
    private readonly tenantDb: TenantDatabase,
    private readonly access: AccessService,
    private readonly authService: AuthService,
  ) {}

  listMembers(ctx: TenantContext): Promise<MemberView[]> {
    return this.tenantDb.run(ctx, (tx) => this.members(tx, ctx));
  }

  async getMember(ctx: TenantContext, userId: string): Promise<MemberView> {
    const [member] = await this.tenantDb.run(ctx, (tx) => this.members(tx, ctx, userId));
    if (!member) throw new NotFoundException('Utilisateur introuvable');
    return member;
  }

  // Filtre explicite sur l'entreprise EN PLUS de la RLS (défense en profondeur).
  private async members(
    tx: TenantTransaction,
    ctx: TenantContext,
    userId?: string,
  ): Promise<MemberView[]> {
    const rows = await tx
      .select({
        membershipId: memberships.id,
        userId: users.id,
        email: users.email,
        fullName: users.fullName,
        status: memberships.status,
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
    const assigned = await tx
      .select({
        membershipId: membershipRoles.membershipId,
        id: roles.id,
        code: roles.code,
        name: roles.name,
        scope: membershipRoles.scope,
      })
      .from(membershipRoles)
      .innerJoin(roles, eq(roles.id, membershipRoles.roleId))
      .where(
        inArray(
          membershipRoles.membershipId,
          rows.map((row) => row.membershipId),
        ),
      );
    return rows.map((row) => ({
      id: row.userId,
      email: row.email,
      fullName: row.fullName,
      status: row.status,
      joinedAt: row.joinedAt.toISOString(),
      roles: assigned
        .filter((role) => role.membershipId === row.membershipId)
        .map(({ id, code, name, scope }) => ({ id, code, name, scope })),
    }));
  }

  /** Active ou désactive un membre (effet immédiat : ses requêtes sont refusées). */
  async setMemberStatus(
    ctx: TenantContext,
    grants: Grants,
    userId: string,
    status: 'ACTIVE' | 'DISABLED',
  ): Promise<MemberView> {
    if (userId === ctx.userId) {
      throw new ForbiddenException('Vous ne pouvez pas modifier votre propre statut');
    }
    return this.tenantDb.run(ctx, async (tx) => {
      const target = await this.access.resolve(tx, { companyId: ctx.companyId, userId });
      // Anti-escalade : impossible d'agir sur un membre qui détient plus de droits que soi.
      if (!grants.canGrant(target.all(), 'COMPANY', [])) {
        throw new ForbiddenException('Ce membre détient des droits supérieurs aux vôtres');
      }
      const updated = await tx
        .update(memberships)
        .set({ status })
        .where(and(eq(memberships.companyId, ctx.companyId), eq(memberships.userId, userId)))
        .returning({ id: memberships.id });
      if (updated.length === 0) throw new NotFoundException('Utilisateur introuvable');
      const [member] = await this.members(tx, ctx, userId);
      if (!member) throw new NotFoundException('Utilisateur introuvable');
      return member;
    });
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

  listInvitations(ctx: TenantContext) {
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
              scope: invitationRoles.scope,
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
      return rows.map((row) => ({
        id: row.id,
        email: row.email,
        status: row.status,
        expired: row.status === 'PENDING' && row.expiresAt.getTime() <= Date.now(),
        expiresAt: row.expiresAt.toISOString(),
        createdAt: row.createdAt.toISOString(),
        roles: roleRows
          .filter((r) => r.invitationId === row.id)
          .map(({ code, scope }) => ({ code, scope })),
      }));
    });
  }

  async createInvitation(ctx: TenantContext, grants: Grants, input: CreateInvitationRequest) {
    if (input.roles.some((role) => role.scope === 'SITES')) {
      // La table des sites arrive au Sprint 2 : la portée SITES est modélisée mais pas encore attribuable.
      throw new UnprocessableEntityException(
        'La portée par site sera disponible avec la gestion des sites (Sprint 2)',
      );
    }
    const token = generateOpaqueToken();
    const result = await this.tenantDb.run(ctx, async (tx) => {
      const roleIds = input.roles.map((role) => role.roleId);
      const found = await tx.select({ id: roles.id }).from(roles).where(inArray(roles.id, roleIds));
      if (found.length !== new Set(roleIds).size) {
        throw new UnprocessableEntityException('Rôle inconnu');
      }
      const perms = await tx
        .select({ code: rolePermissions.permissionCode })
        .from(rolePermissions)
        .where(inArray(rolePermissions.roleId, roleIds));
      if (
        !grants.canGrant(
          perms.map((p) => p.code),
          'COMPANY',
          [],
        )
      ) {
        throw new ForbiddenException(
          'Vous ne pouvez pas attribuer des droits que vous ne détenez pas',
        );
      }

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
        input.roles.map((role) => ({
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
      return {
        invitationId,
        companyName: company?.name ?? '',
        inviterName: inviter?.fullName ?? '',
      };
    });

    this.authService.sendInvitationMail(input.email, token, result.companyName, result.inviterName);
    return { id: result.invitationId };
  }

  async revokeInvitation(ctx: TenantContext, invitationId: string): Promise<void> {
    const updated = await this.tenantDb.run(ctx, (tx) =>
      tx
        .update(invitations)
        .set({ status: 'REVOKED' })
        .where(and(eq(invitations.id, invitationId), eq(invitations.status, 'PENDING')))
        .returning({ id: invitations.id }),
    );
    if (updated.length === 0) throw new NotFoundException('Invitation introuvable');
  }
}

function isUniqueViolation(error: unknown): boolean {
  const cause = (error as { cause?: { code?: string }; code?: string } | undefined) ?? {};
  return cause.code === '23505' || cause.cause?.code === '23505';
}
