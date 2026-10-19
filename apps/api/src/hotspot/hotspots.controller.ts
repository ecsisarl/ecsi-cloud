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
  Req,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  type CreateHotspotRequest,
  createHotspotRequestSchema,
  type ListHotspotsQuery,
  listHotspotsQuerySchema,
  type UpdateHotspotRequest,
  updateHotspotRequestSchema,
} from '@ecsi/shared';
import type { FastifyRequest } from 'fastify';
import { Audited } from '../audit/audit.interceptor.js';
import { CurrentAuth } from '../auth/auth.decorators.js';
import type { AuthContext } from '../auth/auth.types.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { Grants } from '../tenancy/access.service.js';
import { RequireSitePermission } from '../tenancy/permissions.guard.js';
import { tenantContextOf } from '../tenancy/tenant-database.js';
import { HotspotsService } from './hotspots.service.js';

const grantsOf = (request: FastifyRequest) => request.grants ?? Grants.empty();

/**
 * Hotspots (lot B), portée par le site du routeur. Chaque modification publie une nouvelle
 * version de configuration (PENDING) que le worker applique au routeur ; l'API ne parle
 * jamais elle-même à RouterOS. Authentification HTTP-CHAP uniquement (aucune option PAP).
 */
@ApiTags('hotspots')
@Controller('hotspots')
export class HotspotsController {
  constructor(private readonly hotspots: HotspotsService) {}

  @RequireSitePermission('hotspots.read')
  @Get()
  list(
    @CurrentAuth() auth: AuthContext,
    @Req() request: FastifyRequest,
    @Query(new ZodValidationPipe(listHotspotsQuerySchema)) query: ListHotspotsQuery,
  ) {
    return this.hotspots.list(tenantContextOf(auth), grantsOf(request), query);
  }

  @RequireSitePermission('hotspots.read')
  @Get(':id')
  get(
    @CurrentAuth() auth: AuthContext,
    @Req() request: FastifyRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.hotspots.get(tenantContextOf(auth), grantsOf(request), id);
  }

  @RequireSitePermission('hotspots.manage')
  @Audited({ action: 'hotspots.create', resourceType: 'hotspot' })
  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(
    @CurrentAuth() auth: AuthContext,
    @Req() request: FastifyRequest,
    @Body(new ZodValidationPipe(createHotspotRequestSchema)) body: CreateHotspotRequest,
  ) {
    return this.hotspots.create(tenantContextOf(auth), grantsOf(request), body);
  }

  @RequireSitePermission('hotspots.manage')
  @Audited({ action: 'hotspots.update', resourceType: 'hotspot' })
  @Patch(':id')
  update(
    @CurrentAuth() auth: AuthContext,
    @Req() request: FastifyRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(updateHotspotRequestSchema)) body: UpdateHotspotRequest,
  ) {
    return this.hotspots.update(tenantContextOf(auth), grantsOf(request), id, body);
  }

  @RequireSitePermission('hotspots.manage')
  @Audited({ action: 'hotspots.disable', resourceType: 'hotspot' })
  @Post(':id/disable')
  @HttpCode(HttpStatus.OK)
  disable(
    @CurrentAuth() auth: AuthContext,
    @Req() request: FastifyRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.hotspots.setDesiredState(tenantContextOf(auth), grantsOf(request), id, 'DISABLED');
  }

  @RequireSitePermission('hotspots.manage')
  @Audited({ action: 'hotspots.enable', resourceType: 'hotspot' })
  @Post(':id/enable')
  @HttpCode(HttpStatus.OK)
  enable(
    @CurrentAuth() auth: AuthContext,
    @Req() request: FastifyRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.hotspots.setDesiredState(tenantContextOf(auth), grantsOf(request), id, 'ENABLED');
  }

  /** Redemande l'application de la configuration au worker (nouvelle version, PENDING). */
  @RequireSitePermission('hotspots.manage')
  @Audited({ action: 'hotspots.sync', resourceType: 'hotspot' })
  @Post(':id/sync')
  @HttpCode(HttpStatus.OK)
  sync(
    @CurrentAuth() auth: AuthContext,
    @Req() request: FastifyRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.hotspots.sync(tenantContextOf(auth), grantsOf(request), id);
  }

  @RequireSitePermission('hotspots.manage')
  @Audited({ action: 'hotspots.delete', resourceType: 'hotspot' })
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @CurrentAuth() auth: AuthContext,
    @Req() request: FastifyRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<void> {
    await this.hotspots.remove(tenantContextOf(auth), grantsOf(request), id);
  }
}
