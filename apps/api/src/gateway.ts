/**
 * Agent passerelle WireGuard (`pnpm start:gateway`, Sprint 3B), exécuté sur l'hôte de la
 * passerelle : pairs des routeurs enrôlés et activation par le tunnel. Voir
 * routers/gateway/gateway.module.ts et docs/MIKROTIK.md.
 */
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { parseGatewayEnv } from './config/gateway-env.js';
import { GatewayModule } from './routers/gateway/gateway.module.js';

const env = parseGatewayEnv(process.env);
const app = await NestFactory.createApplicationContext(GatewayModule.forRoot(env), {
  bufferLogs: true,
});
app.useLogger(app.get(Logger));
app.enableShutdownHooks();
await app.init();
