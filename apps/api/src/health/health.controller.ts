import { Controller, Get, HttpStatus, Inject, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { HealthResponse } from '@ecsi/shared';
import type { FastifyReply } from 'fastify';
import { HealthService } from './health.service.js';

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(@Inject(HealthService) private readonly health: HealthService) {}

  @Get('live')
  @ApiOperation({ summary: 'Vivacité du processus (sans dépendance externe)' })
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Get()
  @ApiOperation({
    summary:
      'État détaillé : PostgreSQL, Redis, stockage objet. HTTP 503 si un service indispensable est indisponible.',
  })
  async ready(@Res({ passthrough: true }) reply: FastifyReply): Promise<HealthResponse> {
    const result = await this.health.check();
    if (result.status === 'down') {
      void reply.status(HttpStatus.SERVICE_UNAVAILABLE);
    }
    return result;
  }
}
