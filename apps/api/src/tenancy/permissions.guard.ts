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
import { AccessService, type Grants } from './access.service.js';
import { TenantDatabase, tenantContextOf } from './tenant-database.js';

export const REQUIRED_PERMISSIONS = 'ecsi:requiredPermissions';

/**
 * Exige des permissions détenues à l'échelle de l'entreprise. Les routes limitées à un site
 * (Sprint 2 et suivants) vérifieront en plus Grants.hasForSite dans le service.
 */
export const RequirePermissions = (...permissions: Permission[]) =>
  SetMetadata(REQUIRED_PERMISSIONS, permissions);

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
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<Permission[] | undefined>(
      REQUIRED_PERMISSIONS,
      [context.getHandler(), context.getClass()],
    );
    if (!required || required.length === 0) return true;

    const request = context.switchToHttp().getRequest<FastifyRequest>();
    if (!request.auth) throw new ForbiddenException();
    const tenant = tenantContextOf(request.auth);
    const grants = await this.tenantDb.run(tenant, (tx) => this.access.resolve(tx, tenant));
    request.grants = grants;
    if (!required.every((permission) => grants.hasCompanyWide(permission))) {
      throw new ForbiddenException("Vous n'avez pas la permission d'effectuer cette action");
    }
    return true;
  }
}
