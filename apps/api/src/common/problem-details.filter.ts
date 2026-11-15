import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { ProblemDetails } from '@ecsi/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import { TooManyRequestsException } from './errors.js';

const TITLES: Record<number, string> = {
  400: 'Requête invalide',
  401: 'Authentification requise',
  403: 'Accès refusé',
  404: 'Ressource introuvable',
  409: 'Conflit',
  410: 'Ressource expirée',
  415: 'Type de contenu non pris en charge',
  422: 'Données invalides',
  429: 'Trop de requêtes',
  500: 'Erreur interne',
  503: 'Service indisponible',
};

/** Convertit toute exception en réponse « application/problem+json » (RFC 9457), sans fuite interne. */
export function toProblem(
  exception: unknown,
  instance?: string,
  requestId?: string,
): ProblemDetails {
  let status: number = HttpStatus.INTERNAL_SERVER_ERROR;
  let detail: string | undefined;
  let errors: ProblemDetails['errors'];

  if (exception instanceof ZodError) {
    status = HttpStatus.UNPROCESSABLE_ENTITY;
    errors = exception.issues.map((issue) => ({
      path: issue.path.join('.'),
      message: issue.message,
    }));
  } else if (exception instanceof HttpException) {
    status = exception.getStatus();
    const response = exception.getResponse();
    if (typeof response === 'string') {
      detail = response;
    } else if (typeof response === 'object' && 'message' in response) {
      const message = response.message;
      detail = Array.isArray(message) ? message.join(', ') : String(message);
    }
  }

  return {
    type: 'about:blank',
    title: TITLES[status] ?? 'Erreur',
    status,
    // 503 volontaire (ServiceUnavailableException) : message métier rédigé pour l'utilisateur
    // (ex. « Clés de tickets non configurées ») ; les autres erreurs 5xx restent muettes.
    ...(detail && (status < 500 || status === 503) ? { detail } : {}),
    ...(errors ? { errors } : {}),
    ...(instance ? { instance } : {}),
    ...(requestId ? { requestId } : {}),
  };
}

@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  private readonly logger = new Logger(ProblemDetailsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const request = ctx.getRequest<FastifyRequest>();
    const reply = ctx.getResponse<FastifyReply>();
    // Chemin sans chaîne de requête : un jeton (?token=) n'est jamais renvoyé ni journalisé.
    const problem = toProblem(exception, request.url.split('?')[0], request.id);

    if (problem.status >= 500) {
      // `err` passe par le sérialiseur safeError (app.module.ts) : aucun paramètre SQL.
      this.logger.error({ err: exception, requestId: request.id }, 'Erreur non gérée');
    }

    if (exception instanceof TooManyRequestsException) {
      void reply.header('retry-after', String(exception.retryAfterSeconds));
    }

    void reply
      .status(problem.status)
      .header('content-type', 'application/problem+json')
      .send(problem);
  }
}
