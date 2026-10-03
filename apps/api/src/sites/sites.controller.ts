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
  type CreateSiteGroupRequest,
  createSiteGroupRequestSchema,
  type CreateSiteRequest,
  createSiteRequestSchema,
  type ListSitesQuery,
  listSitesQuerySchema,
  siteGroupMembersRequestSchema,
  type UpdateSiteGroupRequest,
  updateSiteGroupRequestSchema,
  type UpdateSiteRequest,
  updateSiteRequestSchema,
} from '@ecsi/shared';
import type { FastifyRequest } from 'fastify';
import { Audited } from '../audit/audit.interceptor.js';
import { CurrentAuth } from '../auth/auth.decorators.js';
import type { AuthContext } from '../auth/auth.types.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { Grants } from '../tenancy/access.service.js';
import { RequirePermissions, RequireSitePermission } from '../tenancy/permissions.guard.js';
import { tenantContextOf } from '../tenancy/tenant-database.js';
import { SitesService } from './sites.service.js';

const grantsOf = (request: FastifyRequest) => request.grants ?? Grants.empty();

@ApiTags('sites')
@Controller('sites')
export class SitesController {
  constructor(private readonly sites: SitesService) {}

  @RequireSitePermission('sites.read')
  @Get()
  list(
    @CurrentAuth() auth: AuthContext,
    @Req() request: FastifyRequest,
    @Query(new ZodValidationPipe(listSitesQuerySchema)) query: ListSitesQuery,
  ) {
    return this.sites.listSites(tenantContextOf(auth), grantsOf(request), query);
  }

  @RequireSitePermission('sites.read')
  @Get(':id')
  get(
    @CurrentAuth() auth: AuthContext,
    @Req() request: FastifyRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.sites.getSite(tenantContextOf(auth), grantsOf(request), id);
  }

  /** Création : droit sur toute l'entreprise (un nouveau site n'est dans aucune portée). */
  @RequirePermissions('sites.create')
  @Audited({ action: 'sites.create', resourceType: 'site' })
  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(createSiteRequestSchema)) body: CreateSiteRequest,
  ) {
    return this.sites.createSite(tenantContextOf(auth), body);
  }

  @RequireSitePermission('sites.update')
  @Audited({ action: 'sites.update', resourceType: 'site' })
  @Patch(':id')
  update(
    @CurrentAuth() auth: AuthContext,
    @Req() request: FastifyRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(updateSiteRequestSchema)) body: UpdateSiteRequest,
  ) {
    return this.sites.updateSite(tenantContextOf(auth), grantsOf(request), id, body);
  }

  @RequireSitePermission('sites.delete')
  @Audited({ action: 'sites.delete', resourceType: 'site' })
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @CurrentAuth() auth: AuthContext,
    @Req() request: FastifyRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<void> {
    await this.sites.deleteSite(tenantContextOf(auth), grantsOf(request), id);
  }
}

@ApiTags('sites')
@Controller('site-groups')
export class SiteGroupsController {
  constructor(private readonly sites: SitesService) {}

  @RequirePermissions('site_groups.read')
  @Get()
  list(@CurrentAuth() auth: AuthContext) {
    return this.sites.listGroups(tenantContextOf(auth));
  }

  @RequirePermissions('site_groups.read')
  @Get(':id')
  get(@CurrentAuth() auth: AuthContext, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.sites.getGroup(tenantContextOf(auth), id);
  }

  @RequirePermissions('site_groups.manage')
  @Audited({ action: 'site_groups.create', resourceType: 'site_group' })
  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(createSiteGroupRequestSchema)) body: CreateSiteGroupRequest,
  ) {
    return this.sites.createGroup(tenantContextOf(auth), body);
  }

  @RequirePermissions('site_groups.manage')
  @Audited({ action: 'site_groups.update', resourceType: 'site_group' })
  @Patch(':id')
  update(
    @CurrentAuth() auth: AuthContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(updateSiteGroupRequestSchema)) body: UpdateSiteGroupRequest,
  ) {
    return this.sites.updateGroup(tenantContextOf(auth), id, body);
  }

  @RequirePermissions('site_groups.manage')
  @Audited({ action: 'site_groups.delete', resourceType: 'site_group' })
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @CurrentAuth() auth: AuthContext,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<void> {
    await this.sites.deleteGroup(tenantContextOf(auth), id);
  }

  @RequirePermissions('site_groups.manage')
  @Audited({ action: 'site_groups.add_sites', resourceType: 'site_group' })
  @Post(':id/sites')
  @HttpCode(HttpStatus.OK)
  addSites(
    @CurrentAuth() auth: AuthContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(siteGroupMembersRequestSchema)) body: { siteIds: string[] },
  ) {
    return this.sites.addGroupSites(tenantContextOf(auth), id, body.siteIds);
  }

  /** Retrait de sites : POST explicite (corps JSON) plutôt qu'un DELETE avec corps. */
  @RequirePermissions('site_groups.manage')
  @Audited({ action: 'site_groups.remove_sites', resourceType: 'site_group' })
  @Post(':id/sites/remove')
  @HttpCode(HttpStatus.OK)
  removeSites(
    @CurrentAuth() auth: AuthContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(siteGroupMembersRequestSchema)) body: { siteIds: string[] },
  ) {
    return this.sites.removeGroupSites(tenantContextOf(auth), id, body.siteIds);
  }
}
