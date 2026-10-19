import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { ConfigAccessService } from './config-access.service.js';
import { EnrollmentService } from './enrollment.service.js';
import { RoutersController } from './routers.controller.js';
import { RoutersService } from './routers.service.js';

/** Routeurs MikroTik côté API : gestion, enrôlement (Sprint 3B). */
@Module({
  imports: [AuthModule],
  controllers: [RoutersController],
  providers: [RoutersService, EnrollmentService, ConfigAccessService],
  exports: [RoutersService],
})
export class RoutersModule {}
