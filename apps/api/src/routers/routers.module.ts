import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { RoutersService } from './routers.service.js';

/** Routeurs MikroTik côté API (Sprint 3A : service seul, aucune route HTTP). */
@Module({
  imports: [AuthModule],
  providers: [RoutersService],
  exports: [RoutersService],
})
export class RoutersModule {}
