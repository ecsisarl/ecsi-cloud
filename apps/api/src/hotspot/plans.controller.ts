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
  Query,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  type CreatePlanRequest,
  createPlanRequestSchema,
  type ListPlansQuery,
  listPlansQuerySchema,
  type UpdatePlanRequest,
  updatePlanRequestSchema,
} from '@ecsi/shared';
import { Audited } from '../audit/audit.interceptor.js';
import { CurrentAuth } from '../auth/auth.decorators.js';
import type { AuthContext } from '../auth/auth.types.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { RequirePermissions, RequireSitePermission } from '../tenancy/permissions.guard.js';
import { tenantContextOf } from '../tenancy/tenant-database.js';
import { PlansService } from './plans.service.js';

/**
 * Forfaits (lot B) : ressource de l'entreprise, partagée par tous ses sites. Lecture avec
 * plans.read sur au moins un site (un vendeur de site voit les forfaits qu'il vend) ;
 * création et modification avec plans.manage pour toute l'entreprise (comme sites.create).
 */
@ApiTags('plans')
@Controller('plans')
export class PlansController {
  constructor(private readonly plans: PlansService) {}

  @RequireSitePermission('plans.read')
  @Get()
  list(
    @CurrentAuth() auth: AuthContext,
    @Query(new ZodValidationPipe(listPlansQuerySchema)) query: ListPlansQuery,
  ) {
    return this.plans.list(tenantContextOf(auth), query);
  }

  @RequireSitePermission('plans.read')
  @Get(':id')
  get(@CurrentAuth() auth: AuthContext, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.plans.get(tenantContextOf(auth), id);
  }

  @RequirePermissions('plans.manage')
  @Audited({ action: 'plans.create', resourceType: 'plan' })
  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(createPlanRequestSchema)) body: CreatePlanRequest,
  ) {
    return this.plans.create(tenantContextOf(auth), body);
  }

  @RequirePermissions('plans.manage')
  @Audited({ action: 'plans.update', resourceType: 'plan' })
  @Patch(':id')
  update(
    @CurrentAuth() auth: AuthContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(updatePlanRequestSchema)) body: UpdatePlanRequest,
  ) {
    return this.plans.update(tenantContextOf(auth), id, body);
  }

  /** Un forfait désactivé ne permet plus de générer de tickets ; les tickets émis restent valables. */
  @RequirePermissions('plans.manage')
  @Audited({ action: 'plans.disable', resourceType: 'plan' })
  @Post(':id/disable')
  @HttpCode(HttpStatus.OK)
  disable(@CurrentAuth() auth: AuthContext, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.plans.setStatus(tenantContextOf(auth), id, 'DISABLED');
  }

  @RequirePermissions('plans.manage')
  @Audited({ action: 'plans.enable', resourceType: 'plan' })
  @Post(':id/enable')
  @HttpCode(HttpStatus.OK)
  enable(@CurrentAuth() auth: AuthContext, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.plans.setStatus(tenantContextOf(auth), id, 'ACTIVE');
  }

  @RequirePermissions('plans.manage')
  @Audited({ action: 'plans.delete', resourceType: 'plan' })
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @CurrentAuth() auth: AuthContext,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<void> {
    await this.plans.remove(tenantContextOf(auth), id);
  }
}
