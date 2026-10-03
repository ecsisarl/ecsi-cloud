import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { API_PREFIX } from '@ecsi/shared';
import { Logger } from 'nestjs-pino';
import { AppModule, type AppOptions } from './app.module.js';
import { type Env, isApiDocsEnabled } from './config/env.js';

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{8,64}$/;

export async function createApp(
  env: Env,
  options: AppOptions = {},
): Promise<NestFastifyApplication> {
  const adapter = new FastifyAdapter({
    // Derrière Nginx : l'adresse IP client est la dernière entrée ajoutée par le proxy de
    // confiance dans X-Forwarded-For (les entrées fournies par le client sont ignorées).
    trustProxy: (_address: string, hop: number) => hop < env.TRUST_PROXY_HOPS,
    bodyLimit: 1_048_576,
    requestIdHeader: 'x-request-id',
    genReqId: (request: IncomingMessage) => {
      const incoming = request.headers['x-request-id'];
      return typeof incoming === 'string' && REQUEST_ID_PATTERN.test(incoming)
        ? incoming
        : randomUUID();
    },
  });

  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule.forRoot(env, options),
    adapter,
    {
      bufferLogs: true,
    },
  );
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

  await app.register(cookie);
  const fastify = app.getHttpAdapter().getInstance();
  // Seul application/json est accepté pour un corps de requête : un formulaire HTML d'un
  // site tiers (text/plain, urlencoded, multipart) est refusé en 415 (défense anti-CSRF).
  // (Nest réenregistre ses analyseurs à l'initialisation : le contrôle se fait donc ici.)
  fastify.addHook('onRequest', async (request, reply) => {
    const hasBody =
      Number(request.headers['content-length'] ?? 0) > 0 ||
      request.headers['transfer-encoding'] !== undefined;
    const type = request.headers['content-type'] ?? '';
    if (hasBody && !/^application\/json(;|$)/i.test(type)) {
      await reply.status(415).header('content-type', 'application/problem+json').send({
        type: 'about:blank',
        title: 'Type de contenu non pris en charge',
        status: 415,
        detail: 'Seul application/json est accepté',
        requestId: request.id,
      });
    }
  });

  fastify.addHook('onSend', async (request, reply) => {
    void reply.header('x-request-id', request.id);
  });

  if (docsEnabled) {
    const config = new DocumentBuilder()
      .setTitle('ECSI CLOUD API')
      .setDescription('API REST ECSI CLOUD — version 1')
      .setVersion(env.APP_VERSION)
      .addCookieAuth('ecsi_at')
      .build();
    SwaggerModule.setup('api/docs', app, () => SwaggerModule.createDocument(app, config), {
      jsonDocumentUrl: 'api/docs/openapi.json',
    });
  }

  return app;
}
