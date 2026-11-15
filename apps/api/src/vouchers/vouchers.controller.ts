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
  type CreatePlanRequest,
  createPlanRequestSchema,
  type DisableVouchersRequest,
  disableVouchersRequestSchema,
  type GenerateVoucherBatchRequest,
  generateVoucherBatchRequestSchema,
  type ListVoucherBatchesQuery,
  listVoucherBatchesQuerySchema,
  type ListVouchersQuery,
  listVouchersQuerySchema,
  type UpdatePlanRequest,
  updatePlanRequestSchema,
} from '@ecsi/shared';
import type { FastifyRequest } from 'fastify';
import { Audited } from '../audit/audit.interceptor.js';
import { CurrentAuth } from '../auth/auth.decorators.js';
import type { AuthContext } from '../auth/auth.types.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { Grants } from '../tenancy/access.service.js';
import { RequirePermissions, RequireSitePermission } from '../tenancy/permissions.guard.js';
import { tenantContextOf } from '../tenancy/tenant-database.js';
import { PlansService } from './plans.service.js';
import { VouchersService } from './vouchers.service.js';

const grantsOf = (request: FastifyRequest) => request.grants ?? Grants.empty();

@ApiTags('plans')
@Controller('plans')
export class PlansController {
  constructor(private readonly plans: PlansService) {}

  /** Lecture ouverte à quiconque détient plans.read sur au moins un site (vendeurs). */
  @RequireSitePermission('plans.read')
  @Get()
  list(@CurrentAuth() auth: AuthContext) {
    return this.plans.list(tenantContextOf(auth));
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

@ApiTags('vouchers')
@Controller('voucher-batches')
export class VoucherBatchesController {
  constructor(private readonly vouchers: VouchersService) {}

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

  @RequireSitePermission('vouchers.generate')
  @Audited({ action: 'vouchers.generate', resourceType: 'voucher_batch' })
  @Post()
  @HttpCode(HttpStatus.CREATED)
  generate(
    @CurrentAuth() auth: AuthContext,
    @Req() request: FastifyRequest,
    @Body(new ZodValidationPipe(generateVoucherBatchRequestSchema))
    body: GenerateVoucherBatchRequest,
  ) {
    return this.vouchers.generate(tenantContextOf(auth), grantsOf(request), body);
  }

  /**
   * Codes en clair pour l'impression. POST (et non GET) : action auditée, protégée par le
   * jeton CSRF, jamais mise en cache ni préchargée par le navigateur.
   */
  @RequireSitePermission('vouchers.export')
  @Audited({ action: 'vouchers.export', resourceType: 'voucher_batch' })
  @Post(':id/print')
  @HttpCode(HttpStatus.OK)
  print(
    @CurrentAuth() auth: AuthContext,
    @Req() request: FastifyRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.vouchers.printBatch(tenantContextOf(auth), grantsOf(request), id);
  }

  @RequireSitePermission('vouchers.disable')
  @Audited({ action: 'vouchers.disable_batch', resourceType: 'voucher_batch' })
  @Post(':id/disable')
  @HttpCode(HttpStatus.OK)
  disable(
    @CurrentAuth() auth: AuthContext,
    @Req() request: FastifyRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(disableVouchersRequestSchema)) body: DisableVouchersRequest,
  ) {
    return this.vouchers.disableBatch(tenantContextOf(auth), grantsOf(request), id, body.reason);
  }
}

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
    return this.vouchers.listVouchers(tenantContextOf(auth), grantsOf(request), query);
  }

  @RequireSitePermission('vouchers.read')
  @Get(':id')
  get(
    @CurrentAuth() auth: AuthContext,
    @Req() request: FastifyRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.vouchers.getVoucher(tenantContextOf(auth), grantsOf(request), id);
  }

  @RequireSitePermission('vouchers.disable')
  @Audited({ action: 'vouchers.disable', resourceType: 'voucher' })
  @Post(':id/disable')
  @HttpCode(HttpStatus.OK)
  disable(
    @CurrentAuth() auth: AuthContext,
    @Req() request: FastifyRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(disableVouchersRequestSchema)) body: DisableVouchersRequest,
  ) {
    return this.vouchers.disableVoucher(tenantContextOf(auth), grantsOf(request), id, body.reason);
  }
}
