import { Body, Controller, Delete, Get, NotFoundException, Patch, Put, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  type CompanySettings,
  type UpdateCompanyProfileRequest,
  updateCompanyProfileRequestSchema,
  updateCompanySettingsRequestSchema,
  type UploadLogoRequest,
  uploadLogoRequestSchema,
} from '@ecsi/shared';
import type { FastifyReply } from 'fastify';
import { Audited } from '../audit/audit.interceptor.js';
import { CurrentAuth } from '../auth/auth.decorators.js';
import type { AuthContext } from '../auth/auth.types.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { RequirePermissions } from '../tenancy/permissions.guard.js';
import { tenantContextOf } from '../tenancy/tenant-database.js';
import { CompaniesService } from './companies.service.js';

/** Entreprise courante (Administration > Entreprise). Aucun identifiant dans l'URL. */
@ApiTags('company')
@Controller('company')
export class CompaniesController {
  constructor(private readonly companies: CompaniesService) {}

  @RequirePermissions('companies.read')
  @Get()
  get(@CurrentAuth() auth: AuthContext) {
    return this.companies.get(tenantContextOf(auth));
  }

  @RequirePermissions('companies.update')
  @Audited({ action: 'company.update', resourceType: 'company' })
  @Patch()
  update(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(updateCompanyProfileRequestSchema))
    body: UpdateCompanyProfileRequest,
  ) {
    return this.companies.updateProfile(tenantContextOf(auth), body);
  }

  @RequirePermissions('settings.manage')
  @Audited({ action: 'company.settings_update', resourceType: 'company' })
  @Put('settings')
  updateSettings(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(updateCompanySettingsRequestSchema)) body: CompanySettings,
  ) {
    return this.companies.updateSettings(tenantContextOf(auth), body);
  }

  @RequirePermissions('companies.update')
  @Audited({ action: 'company.logo_update', resourceType: 'company' })
  @Put('logo')
  uploadLogo(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(uploadLogoRequestSchema)) body: UploadLogoRequest,
  ) {
    return this.companies.uploadLogo(tenantContextOf(auth), body);
  }

  @RequirePermissions('companies.update')
  @Audited({ action: 'company.logo_delete', resourceType: 'company' })
  @Delete('logo')
  deleteLogo(@CurrentAuth() auth: AuthContext) {
    return this.companies.deleteLogo(tenantContextOf(auth));
  }

  /** Logo servi par l'API (fichier privé du stockage), avec un type vérifié à l'envoi. */
  @Get('logo')
  async logo(
    @CurrentAuth() auth: AuthContext,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Buffer> {
    const logo = await this.companies.logo(tenantContextOf(auth));
    if (!logo) throw new NotFoundException('Aucun logo');
    void reply
      .header('content-type', logo.contentType)
      .header('cache-control', 'private, max-age=300')
      .header('content-security-policy', "default-src 'none'; sandbox");
    return logo.data;
  }
}
