/**
 * Worker de supervision MikroTik (`pnpm dev:worker`, `pnpm start:worker`, service `worker`
 * de docker-compose). Contexte d'application NestJS sans HTTP : voir
 * routers/supervision/worker.module.ts et docs/MIKROTIK.md.
 */
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { parseWorkerEnv } from './config/worker-env.js';
import { WorkerModule } from './routers/supervision/worker.module.js';

const env = parseWorkerEnv(process.env);
const app = await NestFactory.createApplicationContext(WorkerModule.forRoot(env), {
  bufferLogs: true,
});
app.useLogger(app.get(Logger));
app.enableShutdownHooks();
await app.init();
