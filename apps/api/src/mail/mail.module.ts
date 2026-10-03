import { type DynamicModule, Global, Module } from '@nestjs/common';
import { ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';
import {
  MAIL_TRANSPORT,
  MailService,
  type MailTransport,
  createSmtpTransport,
} from './mail.service.js';

@Global()
@Module({})
export class MailModule {
  /** `transport` permet aux tests d'intégration de capturer les e-mails (Mailpit en E2E). */
  static forRoot(transport?: MailTransport): DynamicModule {
    return {
      module: MailModule,
      providers: [
        transport
          ? { provide: MAIL_TRANSPORT, useValue: transport }
          : {
              provide: MAIL_TRANSPORT,
              inject: [ENV],
              useFactory: (env: Env) => createSmtpTransport(env),
            },
        MailService,
      ],
      exports: [MailService],
    };
  }
}
