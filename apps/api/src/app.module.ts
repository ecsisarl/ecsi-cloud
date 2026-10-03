import { type DynamicModule, Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { LoggerModule, type Params } from 'nestjs-pino';
import { ProblemDetailsFilter } from './common/problem-details.filter.js';
import { ConfigModule } from './config/config.module.js';
import type { Env } from './config/env.js';
import { AuthModule } from './auth/auth.module.js';
import { DatabaseModule } from './database/database.module.js';
import { HealthModule } from './health/health.module.js';
import { RedisModule } from './redis/redis.module.js';
import { MailModule } from './mail/mail.module.js';
import type { MailTransport } from './mail/mail.service.js';
import { StorageModule } from './storage/storage.module.js';
import { TenancyModule } from './tenancy/tenancy.module.js';
import { UsersModule } from './users/users.module.js';

export interface AppOptions {
  readonly mailTransport?: MailTransport;
  /** Destination des journaux (tests de non-divulgation des secrets). Par défaut : stdout. */
  readonly logDestination?: { write(message: string): void };
}

@Module({})
export class AppModule {
  static forRoot(env: Env, options: AppOptions = {}): DynamicModule {
    return {
      module: AppModule,
      imports: [
        ConfigModule.forRoot(env),
        LoggerModule.forRoot({
          pinoHttp: [
            {
              level: env.LOG_LEVEL,
              // Les en-têtes sensibles ne sont jamais écrits dans les journaux.
              // Les corps de requête ne sont jamais journalisés (mots de passe, codes 2FA, jetons).
              redact: {
                paths: [
                  'req.headers.authorization',
                  'req.headers.cookie',
                  'req.headers["x-csrf-token"]',
                  'res.headers["set-cookie"]',
                  'req.query.token',
                ],
                censor: '[masqué]',
              },
              // L'URL complète peut contenir un jeton (?token=) : seule la route est journalisée.
              serializers: {
                req: (req: { id: unknown; method: string; url: string }) => ({
                  id: req.id,
                  method: req.method,
                  url: req.url.split('?')[0],
                }),
              },
              ...(env.LOG_PRETTY && !options.logDestination
                ? { transport: { target: 'pino-pretty', options: { singleLine: true } } }
                : {}),
            },
            ...(options.logDestination ? [options.logDestination] : []),
          ] as unknown as Params['pinoHttp'],
        }),
        DatabaseModule,
        RedisModule,
        StorageModule,
        MailModule.forRoot(options.mailTransport),
        TenancyModule,
        AuthModule,
        UsersModule,
        HealthModule,
      ],
      providers: [{ provide: APP_FILTER, useClass: ProblemDetailsFilter }],
    };
  }
}
