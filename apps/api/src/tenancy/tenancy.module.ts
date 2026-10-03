import { Global, Module } from '@nestjs/common';
import { AccessService } from './access.service.js';
import { TenantDatabase } from './tenant-database.js';

@Global()
@Module({
  providers: [TenantDatabase, AccessService],
  exports: [TenantDatabase, AccessService],
})
export class TenancyModule {}
