import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import helmet from '@fastify/helmet';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { API_PREFIX } from '@ecsi/shared';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module.js';
import { type Env, isApiDocsEnabled } from './config/env.js';

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{8,64}$/;

export async function createApp(env: Env): Promise<NestFastifyApplication> {
  const adapter = new FastifyAdapter({
    // Derrière Nginx : l'adresse IP client réelle est lue dans X-Forwarded-For.
    trustProxy: true,
    bodyLimit: 1_048_576,
    requestIdHeader: 'x-request-id',
    genReqId: (request: IncomingMessage) => {
      const incoming = request.headers['x-request-id'];
      return typeof incoming === 'string' && REQUEST_ID_PATTERN.test(incoming)
        ? incoming
        : randomUUID();
    },
  });

  const app = await NestFactory.create<NestFastifyApplication>(AppModule.forRoot(env), adapter, {
    bufferLogs: true,
  });
  app.useLogger(app.get(Logger));
  app.enableShutdownHooks();

  const docsEnabled = isApiDocsEnabled(env);
  await app.register(helmet, {
    // La page Swagger UI a besoin de styles et scripts en ligne ; la CSP stricte s'applique partout ailleurs.
    contentSecurityPolicy: docsEnabled ? false : undefined,
  });
  app.enableCors({
    origin: env.CORS_ORIGINS,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  });
  app.setGlobalPrefix(API_PREFIX);

  app
    .getHttpAdapter()
    .getInstance()
    .addHook('onSend', async (request, reply) => {
      void reply.header('x-request-id', request.id);
    });

  if (docsEnabled) {
    const config = new DocumentBuilder()
      .setTitle('ECSI CLOUD API')
      .setDescription('API REST ECSI CLOUD — version 1')
      .setVersion(env.APP_VERSION)
      .addBearerAuth()
      .build();
    SwaggerModule.setup('api/docs', app, () => SwaggerModule.createDocument(app, config), {
      jsonDocumentUrl: 'api/docs/openapi.json',
    });
  }

  return app;
}
