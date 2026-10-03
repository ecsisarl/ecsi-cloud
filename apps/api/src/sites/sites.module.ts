import { Module } from '@nestjs/common';
import { SiteGroupsController, SitesController } from './sites.controller.js';
import { SitesService } from './sites.service.js';

@Module({
  controllers: [SitesController, SiteGroupsController],
  providers: [SitesService],
})
export class SitesModule {}
