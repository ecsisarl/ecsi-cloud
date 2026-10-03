import {
  type CallHandler,
  type ExecutionContext,
  HttpException,
  Injectable,
  Logger,
  type NestInterceptor,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { AuditResult } from '@ecsi/shared';
import type { FastifyRequest } from 'fastify';
import { catchError, from, mergeMap, type Observable, throwError } from 'rxjs';
import { ZodError } from 'zod';
import { AuditService } from './audit.service.js';

export const AUDITED = 'ecsi:audited';

export interface AuditedOptions {
  action: string;
  resourceType: string;
  /** Paramètre d'URL portant l'identifiant de la ressource (« id » par défaut). */
  idParam?: string;
}

/**
 * Déclare une route modifiante comme auditée. Garantit qu'AUCUNE exécution ne passe sans
 * trace : le service écrit l'événement détaillé (avant/après) dans sa transaction ; si la
 * route aboutit sans l'avoir fait, un événement de succès générique est écrit ; si elle
 * échoue (refus, validation, conflit, erreur), un événement DENIED ou FAILURE est écrit
 * hors de la transaction annulée.
 */
export const Audited = (options: AuditedOptions) => SetMetadata(AUDITED, options);

@Injectable()
export class AuditInterceptor implements NestInterceptor {
  private readonly logger = new Logger(AuditInterceptor.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly audit: AuditService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const options = this.reflector.get<AuditedOptions | undefined>(AUDITED, context.getHandler());
    if (!options) return next.handle();
    const request = context.switchToHttp().getRequest<FastifyRequest>();

    return next.handle().pipe(
      mergeMap((value: unknown) =>
        from(
          (async (): Promise<unknown> => {
            if (!request.auditWritten) await this.record(request, options, 'SUCCESS');
            return value;
          })(),
        ),
      ),
      catchError((error: unknown) =>
        from(
          this.record(request, options, resultOf(error), failureDetails(error)).catch(
            (auditError: unknown) => {
              this.logger.error({ err: auditError }, "Échec d'audit d'une requête refusée");
            },
          ),
        ).pipe(mergeMap(() => throwError(() => error))),
      ),
    );
  }

  private async record(
    request: FastifyRequest,
    options: AuditedOptions,
    result: AuditResult,
    details: Record<string, unknown> = {},
  ): Promise<void> {
    const params = (request.params ?? {}) as Record<string, string | undefined>;
    const resourceId = params[options.idParam ?? 'id'] ?? null;
    const companyId = request.auth?.realm === 'user' ? request.auth.companyId : null;
    await this.audit.writeDirect(
      companyId,
      { action: options.action, resourceType: options.resourceType, resourceId, result, details },
      await this.audit.actorFromRequest(request),
      request,
    );
  }
}

function resultOf(error: unknown): AuditResult {
  if (error instanceof HttpException && [401, 403].includes(error.getStatus())) return 'DENIED';
  return 'FAILURE';
}

function failureDetails(error: unknown): Record<string, unknown> {
  if (error instanceof ZodError) return { status: 422, reason: 'Données invalides' };
  if (error instanceof HttpException) {
    const status = error.getStatus();
    // Le message d'une erreur métier est rédigé pour l'utilisateur : jamais de donnée interne.
    return { status, reason: status < 500 ? error.message : 'Erreur interne' };
  }
  return { status: 500, reason: 'Erreur interne' };
}
