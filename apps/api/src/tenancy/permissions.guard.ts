import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Permission } from '@ecsi/shared';
import type { FastifyRequest } from 'fastify';
import { AUDITED, type AuditedOptions } from '../audit/audit.interceptor.js';
import { AuditService } from '../audit/audit.service.js';
import { AccessService, type Grants } from './access.service.js';
import { TenantDatabase, tenantContextOf } from './tenant-database.js';

export const REQUIRED_PERMISSIONS = 'ecsi:requiredPermissions';

interface PermissionRequirement {
  readonly permissions: readonly Permission[];
  /** COMPANY : détenues pour toute l'entreprise ; ANY_SITE : sur au moins un site. */
  readonly scope: 'COMPANY' | 'ANY_SITE';
}

/** Exige des permissions détenues à l'échelle de toute l'entreprise. */
export const RequirePermissions = (...permissions: Permission[]) =>
  SetMetadata(REQUIRED_PERMISSIONS, {
    permissions,
    scope: 'COMPANY',
  } satisfies PermissionRequirement);

/**
 * Route limitée par site : la permission doit être détenue pour toute l'entreprise OU sur
 * au moins un site. Le service vérifie ensuite chaque site concerné (Grants.hasForSite) et
 * filtre les listes (Grants.sitesFor) : un site hors de la portée répond 404.
 */
export const RequireSitePermission = (permission: Permission) =>
  SetMetadata(REQUIRED_PERMISSIONS, {
    permissions: [permission],
    scope: 'ANY_SITE',
  } satisfies PermissionRequirement);

declare module 'fastify' {
  interface FastifyRequest {
    grants?: Grants;
  }
}

@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tenantDb: TenantDatabase,
    private readonly access: AccessService,
    private readonly audit: AuditService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<PermissionRequirement | undefined>(
      REQUIRED_PERMISSIONS,
      [context.getHandler(), context.getClass()],
    );
    if (!required || required.permissions.length === 0) return true;

    const request = context.switchToHttp().getRequest<FastifyRequest>();
    if (!request.auth) throw new ForbiddenException();
    const tenant = tenantContextOf(request.auth);
    const grants = await this.tenantDb.run(tenant, (tx) => this.access.resolve(tx, tenant));
    request.grants = grants;
    const allowed = required.permissions.every((permission) =>
      required.scope === 'COMPANY'
        ? grants.hasCompanyWide(permission)
        : grants.sitesFor(permission) === 'ALL' || grants.sitesFor(permission).length > 0,
    );
    if (!allowed) {
      const audited = this.reflector.get<AuditedOptions | undefined>(AUDITED, context.getHandler());
      if (audited) {
        const params = (request.params ?? {}) as Record<string, string | undefined>;
        await this.audit.writeDirect(
          tenant.companyId,
          {
            action: audited.action,
            resourceType: audited.resourceType,
            resourceId: params[audited.idParam ?? 'id'] ?? null,
            result: 'DENIED',
            details: { status: 403, missing: required.permissions },
          },
          undefined,
          request,
        );
      }
      throw new ForbiddenException("Vous n'avez pas la permission d'effectuer cette action");
    }
    return true;
  }
}
