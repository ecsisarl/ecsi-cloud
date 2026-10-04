import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  type CreateCompanyRequest,
  createCompanyRequestSchema,
  type ListAuditQuery,
  listAuditQuerySchema,
  type ListPlatformCompaniesQuery,
  listPlatformCompaniesQuerySchema,
  type ResetMemberMfaRequest,
  resetMemberMfaRequestSchema,
  type SearchPlatformUsersQuery,
  searchPlatformUsersQuerySchema,
  type SetCompanyStatusRequest,
  setCompanyStatusRequestSchema,
} from '@ecsi/shared';
import { z } from 'zod';
import { Audited } from '../audit/audit.interceptor.js';
import { CurrentAuth, PlatformRealm } from '../auth/auth.decorators.js';
import type { AuthContext } from '../auth/auth.types.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { PlatformService } from './platform.service.js';

const chainKeySchema = z.union([z.literal('platform'), z.uuid()]);

/**
 * Console SUPER_ADMIN : /api/v1/platform/*. Réservée aux sessions du realm « platform »
 * (AuthGuard), 2FA obligatoire. Toutes les mutations sont auditées (@Audited garantit une
 * trace même en cas d'échec ; le service écrit l'événement détaillé dans sa transaction).
 */
@ApiTags('platform')
@PlatformRealm()
@Controller('platform')
export class PlatformController {
  constructor(private readonly platform: PlatformService) {}

  @Get('companies')
  listCompanies(
    @Query(new ZodValidationPipe(listPlatformCompaniesQuerySchema))
    query: ListPlatformCompaniesQuery,
  ) {
    return this.platform.listCompanies(query);
  }

  @Get('companies/:id')
  getCompany(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.platform.getCompany(id);
  }

  /** Routeurs MikroTik d'une entreprise : lecture seule, sans secret (Sprint 3B). */
  @Get('companies/:id/routers')
  listCompanyRouters(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.platform.listCompanyRouters(id);
  }

  @Audited({ action: 'platform.companies.create', resourceType: 'company' })
  @Post('companies')
  @HttpCode(HttpStatus.CREATED)
  createCompany(
    @Body(new ZodValidationPipe(createCompanyRequestSchema)) body: CreateCompanyRequest,
  ) {
    return this.platform.createCompany(body);
  }

  @Audited({ action: 'platform.companies.set_status', resourceType: 'company' })
  @Patch('companies/:id/status')
  setCompanyStatus(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(setCompanyStatusRequestSchema)) body: SetCompanyStatusRequest,
  ) {
    return this.platform.setCompanyStatus(id, body);
  }

  @Get('users')
  searchUsers(
    @Query(new ZodValidationPipe(searchPlatformUsersQuerySchema)) query: SearchPlatformUsersQuery,
  ) {
    return this.platform.searchUsers(query.q);
  }

  @Audited({ action: 'platform.users.mfa_reset', resourceType: 'user' })
  @Post('users/:id/mfa/reset')
  @HttpCode(HttpStatus.NO_CONTENT)
  async resetUserMfa(
    @CurrentAuth() auth: AuthContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(resetMemberMfaRequestSchema)) body: ResetMemberMfaRequest,
  ): Promise<void> {
    await this.platform.resetUserMfa(auth, id, body);
  }

  /** Journal global : toutes les entreprises et la chaîne « platform ». */
  @Get('audit')
  listAudit(
    @Query(new ZodValidationPipe(listAuditQuerySchema.extend({ companyId: z.uuid().optional() })))
    query: ListAuditQuery & { companyId?: string },
  ) {
    const { companyId, ...rest } = query;
    return this.platform.listAudit(rest, companyId);
  }

  @Get('audit/verify/:chainKey')
  verifyAudit(@Param('chainKey', new ZodValidationPipe(chainKeySchema)) chainKey: string) {
    return this.platform.verifyAuditChain(chainKey);
  }

  @Get('audit/:id')
  async getAuditEvent(@Param('id', new ParseUUIDPipe()) id: string) {
    const event = await this.platform.getAuditEvent(id);
    if (!event) throw new NotFoundException('Événement introuvable');
    return event;
  }
}
