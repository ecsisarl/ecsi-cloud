import { Controller, Get, NotFoundException, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { type ListAuditQuery, listAuditQuerySchema } from '@ecsi/shared';
import { CurrentAuth } from '../auth/auth.decorators.js';
import type { AuthContext } from '../auth/auth.types.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { RequirePermissions } from '../tenancy/permissions.guard.js';
import { TenantDatabase, tenantContextOf } from '../tenancy/tenant-database.js';
import { getAuditEvent, listAuditEvents } from './audit-query.js';

/** Journal d'audit de l'entreprise courante (Administration > Journal d'audit). */
@ApiTags('audit')
@Controller('audit')
export class AuditController {
  constructor(private readonly tenantDb: TenantDatabase) {}

  @RequirePermissions('audit.read')
  @Get()
  list(
    @CurrentAuth() auth: AuthContext,
    @Query(new ZodValidationPipe(listAuditQuerySchema)) query: ListAuditQuery,
  ) {
    const ctx = tenantContextOf(auth);
    return this.tenantDb.run(ctx, (tx) => listAuditEvents(tx, query, ctx.companyId));
  }

  @RequirePermissions('audit.read')
  @Get(':id')
  async get(@CurrentAuth() auth: AuthContext, @Param('id', new ParseUUIDPipe()) id: string) {
    const ctx = tenantContextOf(auth);
    const event = await this.tenantDb.run(ctx, (tx) => getAuditEvent(tx, id, ctx.companyId));
    if (!event) throw new NotFoundException('Événement introuvable');
    return event;
  }
}
