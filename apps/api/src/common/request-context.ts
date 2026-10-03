import { AsyncLocalStorage } from 'node:async_hooks';
import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { Observable } from 'rxjs';

/**
 * Requête HTTP en cours, accessible sans la passer de service en service (journal d'audit :
 * adresse IP, user-agent, identifiant de requête, acteur). Alimenté par RequestContextInterceptor.
 */
const storage = new AsyncLocalStorage<FastifyRequest>();

export function currentRequest(): FastifyRequest | undefined {
  return storage.getStore();
}

export function runWithRequest<T>(request: FastifyRequest, work: () => T): T {
  return storage.run(request, work);
}

@Injectable()
export class RequestContextInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    return new Observable((subscriber) =>
      storage.run(request, () => next.handle().subscribe(subscriber)),
    );
  }
}

export interface RequestInfo {
  ip: string | null;
  userAgent: string | null;
  requestId: string | null;
}

export function requestInfo(request = currentRequest()): RequestInfo {
  if (!request) return { ip: null, userAgent: null, requestId: null };
  const userAgent = request.headers['user-agent'];
  return {
    ip: request.ip,
    userAgent: typeof userAgent === 'string' ? userAgent.slice(0, 512) : null,
    requestId: request.id,
  };
}
