import {
  createParamDecorator,
  type ExecutionContext,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import type { AuthContext, RequestMeta } from './auth.types.js';

export const IS_PUBLIC = 'ecsi:isPublic';
export const ALLOW_MFA_SETUP = 'ecsi:allowMfaSetup';
export const PLATFORM_REALM = 'ecsi:platformRealm';

/** Route accessible sans session (connexion, mot de passe oublié…). */
export const Public = () => SetMetadata(IS_PUBLIC, true);

/** Route accessible à une session dont la 2FA obligatoire n'est pas encore configurée. */
export const AllowMfaSetup = () => SetMetadata(ALLOW_MFA_SETUP, true);

/** Route réservée aux super administrateurs ECSI (realm « platform »). */
export const PlatformRealm = () => SetMetadata(PLATFORM_REALM, true);

export const CurrentAuth = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): AuthContext => {
    const request = ctx.switchToHttp().getRequest<FastifyRequest>();
    if (!request.auth) throw new UnauthorizedException();
    return request.auth;
  },
);

export const ReqMeta = createParamDecorator((_: unknown, ctx: ExecutionContext): RequestMeta => {
  const request = ctx.switchToHttp().getRequest<FastifyRequest>();
  const userAgent = request.headers['user-agent'];
  return {
    ip: request.ip,
    userAgent: typeof userAgent === 'string' ? userAgent.slice(0, 512) : null,
  };
});
