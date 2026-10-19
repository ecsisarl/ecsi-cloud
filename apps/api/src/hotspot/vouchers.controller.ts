import {
  Body,
  Controller,
  Get,
  Header,
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
  type CreateVoucherBatchRequest,
  createVoucherBatchRequestSchema,
  type DisableVoucherRequest,
  disableVoucherRequestSchema,
  type ListRadiusSessionsQuery,
  listRadiusSessionsQuerySchema,
  type ListVoucherBatchesQuery,
  listVoucherBatchesQuerySchema,
  type ListVouchersQuery,
  listVouchersQuerySchema,
} from '@ecsi/shared';
import type { FastifyRequest } from 'fastify';
import { Audited } from '../audit/audit.interceptor.js';
import { CurrentAuth } from '../auth/auth.decorators.js';
import type { AuthContext } from '../auth/auth.types.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { Grants } from '../tenancy/access.service.js';
import { RequireSitePermission } from '../tenancy/permissions.guard.js';
import { tenantContextOf } from '../tenancy/tenant-database.js';
import { RadiusSessionsService } from './sessions.service.js';
import { VouchersService } from './vouchers.service.js';

const grantsOf = (request: FastifyRequest) => request.grants ?? Grants.empty();

/**
 * Lots de tickets (lot B). Portée par site : la garde vérifie la permission sur au moins un
 * site, le service la confronte au site du lot. Les codes ne sortent que par l'impression
 * (vouchers.export), jamais mise en cache (no-store) et auditée avec un simple nombre.
 */
@ApiTags('vouchers')
@Controller('voucher-batches')
export class VoucherBatchesController {
  constructor(private readonly vouchers: VouchersService) {}

  @RequireSitePermission('vouchers.generate')
  @Audited({ action: 'vouchers.generate', resourceType: 'voucher_batch' })
  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(
    @CurrentAuth() auth: AuthContext,
    @Req() request: FastifyRequest,
    @Body(new ZodValidationPipe(createVoucherBatchRequestSchema)) body: CreateVoucherBatchRequest,
  ) {
    return this.vouchers.generate(tenantContextOf(auth), grantsOf(request), body);
  }

  @RequireSitePermission('vouchers.read')
  @Get()
  list(
    @CurrentAuth() auth: AuthContext,
    @Req() request: FastifyRequest,
    @Query(new ZodValidationPipe(listVoucherBatchesQuerySchema)) query: ListVoucherBatchesQuery,
  ) {
    return this.vouchers.listBatches(tenantContextOf(auth), grantsOf(request), query);
  }

  @RequireSitePermission('vouchers.read')
  @Get(':id')
  get(
    @CurrentAuth() auth: AuthContext,
    @Req() request: FastifyRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.vouchers.getBatch(tenantContextOf(auth), grantsOf(request), id);
  }

  /** Feuille d'impression du lot, avec les codes : jamais mise en cache, auditée. */
  @RequireSitePermission('vouchers.export')
  @Audited({ action: 'vouchers.export', resourceType: 'voucher_batch' })
  @Get(':id/print')
  @Header('Cache-Control', 'no-store')
  @Header('Pragma', 'no-cache')
  print(
    @CurrentAuth() auth: AuthContext,
    @Req() request: FastifyRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.vouchers.printBatch(tenantContextOf(auth), grantsOf(request), id);
  }
}

/** Tickets : liste, détail (sans code), impression unitaire, désactivation. */
@ApiTags('vouchers')
@Controller('vouchers')
export class VouchersController {
  constructor(private readonly vouchers: VouchersService) {}

  @RequireSitePermission('vouchers.read')
  @Get()
  list(
    @CurrentAuth() auth: AuthContext,
    @Req() request: FastifyRequest,
    @Query(new ZodValidationPipe(listVouchersQuerySchema)) query: ListVouchersQuery,
  ) {
    return this.vouchers.list(tenantContextOf(auth), grantsOf(request), query);
  }

  @RequireSitePermission('vouchers.read')
  @Get(':id')
  get(
    @CurrentAuth() auth: AuthContext,
    @Req() request: FastifyRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.vouchers.get(tenantContextOf(auth), grantsOf(request), id);
  }

  @RequireSitePermission('vouchers.export')
  @Audited({ action: 'vouchers.export', resourceType: 'voucher' })
  @Post(':id/print')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  @Header('Pragma', 'no-cache')
  print(
    @CurrentAuth() auth: AuthContext,
    @Req() request: FastifyRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.vouchers.printOne(tenantContextOf(auth), grantsOf(request), id);
  }

  @RequireSitePermission('vouchers.disable')
  @Audited({ action: 'vouchers.disable', resourceType: 'voucher' })
  @Post(':id/disable')
  @HttpCode(HttpStatus.OK)
  disable(
    @CurrentAuth() auth: AuthContext,
    @Req() request: FastifyRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(disableVoucherRequestSchema)) body: DisableVoucherRequest,
  ) {
    return this.vouchers.disable(tenantContextOf(auth), grantsOf(request), id, body);
  }
}

/** Sessions RADIUS (clients.read) : ticket par son numéro de série, jamais par son code. */
@ApiTags('radius')
@Controller('radius-sessions')
export class RadiusSessionsController {
  constructor(private readonly sessions: RadiusSessionsService) {}

  @RequireSitePermission('clients.read')
  @Get()
  list(
    @CurrentAuth() auth: AuthContext,
    @Req() request: FastifyRequest,
    @Query(new ZodValidationPipe(listRadiusSessionsQuerySchema)) query: ListRadiusSessionsQuery,
  ) {
    return this.sessions.list(tenantContextOf(auth), grantsOf(request), query);
  }
}
