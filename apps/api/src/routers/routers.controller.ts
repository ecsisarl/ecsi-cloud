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
  Put,
  Query,
  Req,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  type CreateEnrollmentRequest,
  createEnrollmentRequestSchema,
  type EnrollRequest,
  enrollRequestSchema,
  type ListRoutersQuery,
  listRoutersQuerySchema,
  type RegisterRouterRequest,
  registerRouterRequestSchema,
  type RouterCredentialsRequest,
  routerCredentialsRequestSchema,
  type UpdateRouterRequest,
  updateRouterRequestSchema,
} from '@ecsi/shared';
import type { FastifyRequest } from 'fastify';
import { Audited } from '../audit/audit.interceptor.js';
import { CurrentAuth, Public, ReqMeta } from '../auth/auth.decorators.js';
import type { AuthContext, RequestMeta } from '../auth/auth.types.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { Grants } from '../tenancy/access.service.js';
import { RequireSitePermission } from '../tenancy/permissions.guard.js';
import { tenantContextOf } from '../tenancy/tenant-database.js';
import { EnrollmentService } from './enrollment.service.js';
import { RoutersService } from './routers.service.js';

const grantsOf = (request: FastifyRequest) => request.grants ?? Grants.empty();

/**
 * Routeurs MikroTik de l'entreprise (Sprint 3B). Portée par site : la garde vérifie que la
 * permission est détenue sur au moins un site, le service la confronte au site du routeur.
 * Aucune réponse ne contient de secret (mot de passe RouterOS, clé privée, jeton haché) ; le
 * jeton d'enrôlement n'apparaît qu'une fois, dans le script renvoyé à sa création.
 */
@ApiTags('routers')
@Controller('routers')
export class RoutersController {
  constructor(
    private readonly routers: RoutersService,
    private readonly enrollment: EnrollmentService,
  ) {}

  @RequireSitePermission('routers.read')
  @Get()
  list(
    @CurrentAuth() auth: AuthContext,
    @Req() request: FastifyRequest,
    @Query(new ZodValidationPipe(listRoutersQuerySchema)) query: ListRoutersQuery,
  ) {
    return this.routers.list(tenantContextOf(auth), grantsOf(request), query);
  }

  /** Détail : identité, système, interfaces, supervision, tunnel (sans secret). */
  @RequireSitePermission('routers.read')
  @Get(':id')
  get(
    @CurrentAuth() auth: AuthContext,
    @Req() request: FastifyRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.routers.get(tenantContextOf(auth), grantsOf(request), id);
  }

  /** « Ajouter un routeur » : adresse tunnel attribuée, jeton et script (affichés une fois). */
  @RequireSitePermission('routers.create')
  @Audited({ action: 'routers.enrollment.create', resourceType: 'router' })
  @Post('enrollments')
  @HttpCode(HttpStatus.CREATED)
  createEnrollment(
    @CurrentAuth() auth: AuthContext,
    @Req() request: FastifyRequest,
    @Body(new ZodValidationPipe(createEnrollmentRequestSchema)) body: CreateEnrollmentRequest,
  ) {
    return this.enrollment.create(tenantContextOf(auth), grantsOf(request), body);
  }

  /** Nouveau jeton et nouveau script pour un routeur pas encore enrôlé. */
  @RequireSitePermission('routers.create')
  @Audited({ action: 'routers.enrollment.renew', resourceType: 'router' })
  @Post(':id/enrollment')
  @HttpCode(HttpStatus.CREATED)
  renewEnrollment(
    @CurrentAuth() auth: AuthContext,
    @Req() request: FastifyRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.enrollment.renew(tenantContextOf(auth), grantsOf(request), id);
  }

  /**
   * Appelé par le ROUTEUR (étape 6 du script), sans session : jeton à usage unique et clé
   * publique WireGuard, rien d'autre (schéma strict). Limité par adresse IP ; tout refus
   * répond 410 sans préciser le motif.
   */
  @Public()
  @Post('enroll')
  @HttpCode(HttpStatus.OK)
  enroll(
    @Body(new ZodValidationPipe(enrollRequestSchema)) body: EnrollRequest,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.enrollment.enroll(body, meta.ip);
  }

  /** Enregistrement manuel d'un routeur déjà configuré (adresse tunnel fournie). */
  @RequireSitePermission('routers.create')
  @Audited({ action: 'routers.create', resourceType: 'router' })
  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(
    @CurrentAuth() auth: AuthContext,
    @Req() request: FastifyRequest,
    @Body(new ZodValidationPipe(registerRouterRequestSchema)) body: RegisterRouterRequest,
  ) {
    return this.routers.create(tenantContextOf(auth), grantsOf(request), body);
  }

  @RequireSitePermission('routers.update')
  @Audited({ action: 'routers.update', resourceType: 'router' })
  @Patch(':id')
  update(
    @CurrentAuth() auth: AuthContext,
    @Req() request: FastifyRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(updateRouterRequestSchema)) body: UpdateRouterRequest,
  ) {
    return this.routers.update(tenantContextOf(auth), grantsOf(request), id, body);
  }

  /** Changement des identifiants RouterOS : le mot de passe est chiffré, jamais renvoyé. */
  @RequireSitePermission('routers.update')
  @Audited({ action: 'routers.credentials.update', resourceType: 'router' })
  @Put(':id/credentials')
  changeCredentials(
    @CurrentAuth() auth: AuthContext,
    @Req() request: FastifyRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(routerCredentialsRequestSchema)) body: RouterCredentialsRequest,
  ) {
    return this.routers.changeCredentials(tenantContextOf(auth), grantsOf(request), id, body);
  }

  /** Suppression logique (désactivation) : invisible de l'API, du worker et de la passerelle. */
  @RequireSitePermission('routers.delete')
  @Audited({ action: 'routers.delete', resourceType: 'router' })
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @CurrentAuth() auth: AuthContext,
    @Req() request: FastifyRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<void> {
    await this.routers.remove(tenantContextOf(auth), grantsOf(request), id);
  }
}
