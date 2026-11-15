import { Module } from '@nestjs/common';
import { PlansService } from './plans.service.js';
import {
  PlansController,
  VoucherBatchesController,
  VouchersController,
} from './vouchers.controller.js';
import { VouchersService } from './vouchers.service.js';

/** Forfaits et tickets (Sprint 6, épopée E9). */
@Module({
  controllers: [PlansController, VoucherBatchesController, VouchersController],
  providers: [PlansService, VouchersService],
})
export class VouchersModule {}
