import { Module } from '@nestjs/common';
import { ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';
import { HotspotsController } from './hotspots.controller.js';
import { HotspotsService } from './hotspots.service.js';
import { PlansController } from './plans.controller.js';
import { PlansService } from './plans.service.js';
import { RadiusSessionsService } from './sessions.service.js';
import { VoucherKeys } from './voucher-keys.js';
import {
  RadiusSessionsController,
  VoucherBatchesController,
  VouchersController,
} from './vouchers.controller.js';
import { VouchersService } from './vouchers.service.js';

/** Lot B côté API : forfaits, lots et tickets, hotspots, sessions RADIUS (lecture). */
@Module({
  controllers: [
    PlansController,
    VoucherBatchesController,
    VouchersController,
    RadiusSessionsController,
    HotspotsController,
  ],
  providers: [
    PlansService,
    VouchersService,
    RadiusSessionsService,
    HotspotsService,
    { provide: VoucherKeys, inject: [ENV], useFactory: (env: Env) => new VoucherKeys(env) },
  ],
})
export class HotspotModule {}
