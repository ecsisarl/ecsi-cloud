import { Inject, Injectable, Logger } from '@nestjs/common';
import nodemailer, { type Transporter } from 'nodemailer';
import { ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';

export interface OutgoingMail {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly html: string;
}

export const MAIL_TRANSPORT = Symbol('MAIL_TRANSPORT');

/** Contrat minimal du transport (nodemailer en exécution, capture en test d'intégration). */
export interface MailTransport {
  sendMail(mail: OutgoingMail & { from: string }): Promise<unknown>;
}

export function createSmtpTransport(env: Env): Transporter {
  return nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_SECURE,
    ...(env.SMTP_USER ? { auth: { user: env.SMTP_USER, pass: env.SMTP_PASSWORD ?? '' } } : {}),
  });
}

/**
 * Envoi des e-mails transactionnels. En développement, Mailpit capture tout
 * (http://localhost:8025) : aucun e-mail ne sort. Le contenu des messages (liens
 * contenant des jetons) n'est jamais journalisé.
 */
@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);

  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(MAIL_TRANSPORT) private readonly transport: MailTransport,
  ) {}

  async send(mail: OutgoingMail): Promise<void> {
    await this.transport.sendMail({ ...mail, from: this.env.SMTP_FROM });
  }

  /** Envoi sans bloquer la réponse HTTP (même durée de réponse que le compte existe ou non). */
  sendInBackground(mail: OutgoingMail, kind: string): void {
    this.send(mail).catch((error: unknown) => {
      this.logger.error(
        { event: 'mail.failed', kind, err: error instanceof Error ? error.message : 'inconnue' },
        "Échec d'envoi d'e-mail",
      );
    });
  }
}
