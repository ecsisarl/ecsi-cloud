import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  Req,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  type CreateInvitationRequest,
  createInvitationRequestSchema,
  type ListMembersQuery,
  listMembersQuerySchema,
  type ReplaceMemberRolesRequest,
  replaceMemberRolesRequestSchema,
  type ResetMemberMfaRequest,
  resetMemberMfaRequestSchema,
  updateMemberStatusRequestSchema,
} from '@ecsi/shared';
import type { FastifyRequest } from 'fastify';
import { Audited } from '../audit/audit.interceptor.js';
import { CurrentAuth } from '../auth/auth.decorators.js';
import type { AuthContext } from '../auth/auth.types.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { Grants } from '../tenancy/access.service.js';
import { RequireSitePermission } from '../tenancy/permissions.guard.js';
import { tenantContextOf } from '../tenancy/tenant-database.js';
import { UsersService } from './users.service.js';

export const grantsOf = (request: FastifyRequest) => request.grants ?? Grants.empty();

/**
 * Membres de l'entreprise courante. Les routes acceptent une portée par site : un gérant
 * limité à ses sites gère les membres de ses sites (voir UsersService).
 */
@ApiTags('users')
@Controller()
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @RequireSitePermission('users.read')
  @Get('users')
  list(
    @CurrentAuth() auth: AuthContext,
    @Req() request: FastifyRequest,
    @Query(new ZodValidationPipe(listMembersQuerySchema)) query: ListMembersQuery,
  ) {
    return this.users.listMembers(tenantContextOf(auth), grantsOf(request), query);
  }

  @RequireSitePermission('users.read')
  @Get('users/:id')
  get(
    @CurrentAuth() auth: AuthContext,
    @Req() request: FastifyRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.users.getMember(tenantContextOf(auth), grantsOf(request), id);
  }

  @RequireSitePermission('users.disable')
  @Audited({ action: 'users.status_update', resourceType: 'user' })
  @Patch('users/:id/status')
  setStatus(
    @CurrentAuth() auth: AuthContext,
    @Req() request: FastifyRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(updateMemberStatusRequestSchema))
    body: { status: 'ACTIVE' | 'DISABLED' },
  ) {
    return this.users.setMemberStatus(tenantContextOf(auth), grantsOf(request), id, body.status);
  }

  @RequireSitePermission('users.update')
  @Audited({ action: 'users.roles_update', resourceType: 'user' })
  @Put('users/:id/roles')
  replaceRoles(
    @CurrentAuth() auth: AuthContext,
    @Req() request: FastifyRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(replaceMemberRolesRequestSchema)) body: ReplaceMemberRolesRequest,
  ) {
    return this.users.replaceRoles(tenantContextOf(auth), grantsOf(request), id, body.roles);
  }

  @RequireSitePermission('users.remove')
  @Audited({ action: 'users.remove', resourceType: 'user' })
  @Delete('users/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @CurrentAuth() auth: AuthContext,
    @Req() request: FastifyRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<void> {
    await this.users.removeMember(tenantContextOf(auth), grantsOf(request), id);
  }

  @RequireSitePermission('users.mfa.reset')
  @Audited({ action: 'users.mfa_reset', resourceType: 'user' })
  @Post('users/:id/mfa/reset')
  @HttpCode(HttpStatus.NO_CONTENT)
  async resetMfa(
    @CurrentAuth() auth: AuthContext,
    @Req() request: FastifyRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(resetMemberMfaRequestSchema)) body: ResetMemberMfaRequest,
  ): Promise<void> {
    await this.users.resetMfa(tenantContextOf(auth), grantsOf(request), auth, id, body);
  }

  /** Catalogue des rôles (non sensible) : lisible aussi par un gestionnaire limité à ses sites. */
  @RequireSitePermission('roles.read')
  @Get('roles')
  roles(@CurrentAuth() auth: AuthContext) {
    return this.users.listRoles(tenantContextOf(auth));
  }

  @RequireSitePermission('users.read')
  @Get('invitations')
  invitations(@CurrentAuth() auth: AuthContext, @Req() request: FastifyRequest) {
    return this.users.listInvitations(tenantContextOf(auth), grantsOf(request));
  }

  @RequireSitePermission('users.invite')
  @Audited({ action: 'invitations.create', resourceType: 'invitation' })
  @Post('invitations')
  @HttpCode(HttpStatus.CREATED)
  invite(
    @CurrentAuth() auth: AuthContext,
    @Req() request: FastifyRequest,
    @Body(new ZodValidationPipe(createInvitationRequestSchema)) body: CreateInvitationRequest,
  ) {
    return this.users.createInvitation(tenantContextOf(auth), grantsOf(request), body);
  }

  @RequireSitePermission('users.invite')
  @Audited({ action: 'invitations.revoke', resourceType: 'invitation' })
  @Delete('invitations/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async revoke(
    @CurrentAuth() auth: AuthContext,
    @Req() request: FastifyRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<void> {
    await this.users.revokeInvitation(tenantContextOf(auth), grantsOf(request), id);
  }
}
