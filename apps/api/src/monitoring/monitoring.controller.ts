import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  type ListAlertsQuery,
  listAlertsQuerySchema,
  type RouterMetricsQuery,
  routerMetricsQuerySchema,
} from '@ecsi/shared';
import type { FastifyRequest } from 'fastify';
import { Audited } from '../audit/audit.interceptor.js';
import { CurrentAuth } from '../auth/auth.decorators.js';
import type { AuthContext } from '../auth/auth.types.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { Grants } from '../tenancy/access.service.js';
import { RequireSitePermission } from '../tenancy/permissions.guard.js';
import { tenantContextOf } from '../tenancy/tenant-database.js';
import { MonitoringService } from './monitoring.service.js';

const grantsOf = (request: FastifyRequest) => request.grants ?? Grants.empty();

/**
 * Supervision et alertes dans l'application (lot E1). Lecture seule des données écrites par
 * le worker, sauf l'acquittement d'une alerte (audité). Portée par site : la garde vérifie
 * la permission sur au moins un site, le service filtre et confronte chaque routeur.
 */
@ApiTags('monitoring')
@Controller('monitoring')
export class MonitoringController {
  constructor(private readonly monitoring: MonitoringService) {}

  /** Compteurs (routeurs par statut, alertes ouvertes) et liste des routeurs supervisés. */
  @RequireSitePermission('monitoring.read')
  @Get('overview')
  overview(@CurrentAuth() auth: AuthContext, @Req() request: FastifyRequest) {
    return this.monitoring.overview(tenantContextOf(auth), grantsOf(request));
  }

  /** Compteurs d'alertes ouvertes seulement : indicateur de l'en-tête du dashboard. */
  @RequireSitePermission('monitoring.read')
  @Get('alerts/summary')
  summary(@CurrentAuth() auth: AuthContext, @Req() request: FastifyRequest) {
    return this.monitoring.summary(tenantContextOf(auth), grantsOf(request));
  }

  @RequireSitePermission('monitoring.read')
  @Get('alerts')
  alerts(
    @CurrentAuth() auth: AuthContext,
    @Req() request: FastifyRequest,
    @Query(new ZodValidationPipe(listAlertsQuerySchema)) query: ListAlertsQuery,
  ) {
    return this.monitoring.listAlerts(tenantContextOf(auth), grantsOf(request), query);
  }

  /** Historique agrégé d'un routeur (charge CPU, mémoire, disponibilité). */
  @RequireSitePermission('monitoring.read')
  @Get('routers/:id/metrics')
  metrics(
    @CurrentAuth() auth: AuthContext,
    @Req() request: FastifyRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query(new ZodValidationPipe(routerMetricsQuerySchema)) query: RouterMetricsQuery,
  ) {
    return this.monitoring.routerMetrics(tenantContextOf(auth), grantsOf(request), id, query);
  }

  @RequireSitePermission('monitoring.acknowledge')
  @Audited({ action: 'monitoring.alert.acknowledge', resourceType: 'alert' })
  @Post('alerts/:id/acknowledge')
  @HttpCode(HttpStatus.OK)
  acknowledge(
    @CurrentAuth() auth: AuthContext,
    @Req() request: FastifyRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.monitoring.acknowledge(tenantContextOf(auth), grantsOf(request), id);
  }
}
