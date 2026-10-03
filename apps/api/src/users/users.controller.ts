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
  Req,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  type CreateInvitationRequest,
  createInvitationRequestSchema,
  updateMemberStatusRequestSchema,
} from '@ecsi/shared';
import type { FastifyRequest } from 'fastify';
import { CurrentAuth } from '../auth/auth.decorators.js';
import type { AuthContext } from '../auth/auth.types.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { Grants } from '../tenancy/access.service.js';
import { RequirePermissions } from '../tenancy/permissions.guard.js';
import { tenantContextOf } from '../tenancy/tenant-database.js';
import { UsersService } from './users.service.js';

const grantsOf = (request: FastifyRequest) => request.grants ?? Grants.empty();

@ApiTags('users')
@Controller()
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @RequirePermissions('users.read')
  @Get('users')
  list(@CurrentAuth() auth: AuthContext) {
    return this.users.listMembers(tenantContextOf(auth));
  }

  @RequirePermissions('users.read')
  @Get('users/:id')
  get(@CurrentAuth() auth: AuthContext, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.users.getMember(tenantContextOf(auth), id);
  }

  @RequirePermissions('users.disable')
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

  @RequirePermissions('roles.read')
  @Get('roles')
  roles(@CurrentAuth() auth: AuthContext) {
    return this.users.listRoles(tenantContextOf(auth));
  }

  @RequirePermissions('users.read')
  @Get('invitations')
  invitations(@CurrentAuth() auth: AuthContext) {
    return this.users.listInvitations(tenantContextOf(auth));
  }

  @RequirePermissions('users.invite')
  @Post('invitations')
  @HttpCode(HttpStatus.CREATED)
  invite(
    @CurrentAuth() auth: AuthContext,
    @Req() request: FastifyRequest,
    @Body(new ZodValidationPipe(createInvitationRequestSchema)) body: CreateInvitationRequest,
  ) {
    return this.users.createInvitation(tenantContextOf(auth), grantsOf(request), body);
  }

  @RequirePermissions('users.invite')
  @Delete('invitations/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async revoke(@CurrentAuth() auth: AuthContext, @Param('id', new ParseUUIDPipe()) id: string) {
    await this.users.revokeInvitation(tenantContextOf(auth), id);
  }
}
