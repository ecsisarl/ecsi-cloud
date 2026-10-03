import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AUTH_COOKIES, CSRF_HEADER } from '@ecsi/shared';
import type { FastifyRequest } from 'fastify';
import { AccessTokenService } from './access-token.service.js';
import { ALLOW_MFA_SETUP, IS_PUBLIC, PLATFORM_REALM } from './auth.decorators.js';
import { safeEqual } from './crypto/tokens.js';
import { SessionService } from './session.service.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Code renvoyé quand la 2FA obligatoire doit être configurée avant tout autre accès. */
export const MFA_SETUP_REQUIRED = 'MFA_SETUP_REQUIRED';

/**
 * Garde globale : toute route est protégée sauf @Public().
 *  1. jeton d'accès (cookie httpOnly) vérifié : signature, émetteur, audience, expiration ;
 *  2. session relue en base : non révoquée, non expirée, compte et appartenance actifs ;
 *  3. realm de la route respecté (utilisateur d'entreprise ≠ super administrateur) ;
 *  4. 2FA obligatoire non configurée -> seules les routes @AllowMfaSetup() sont permises ;
 *  5. CSRF (double soumission) : pour toute méthode non sûre, l'en-tête X-CSRF-Token doit
 *     être égal au cookie ecsi_csrf, qu'un site tiers ne peut ni lire ni écrire.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly accessTokens: AccessTokenService,
    private readonly sessions: SessionService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;

    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const token = request.cookies[AUTH_COOKIES.access];
    if (!token) throw new UnauthorizedException('Authentification requise');

    const claims = await this.accessTokens.verify(token);
    if (!claims) throw new UnauthorizedException('Session expirée');

    const platformRoute =
      this.reflector.getAllAndOverride<boolean | undefined>(PLATFORM_REALM, targets) === true;
    if ((claims.realm === 'platform') !== platformRoute) {
      throw new ForbiddenException('Accès refusé');
    }

    if (!SAFE_METHODS.has(request.method)) {
      const header = request.headers[CSRF_HEADER];
      const cookie = request.cookies[AUTH_COOKIES.csrf];
      if (typeof header !== 'string' || !cookie || !safeEqual(header, cookie)) {
        throw new ForbiddenException('Jeton CSRF invalide');
      }
    }

    const auth = await this.sessions.loadContext(claims);
    if (!auth) throw new UnauthorizedException('Session expirée');

    if (
      auth.mfaState === 'SETUP_REQUIRED' &&
      !this.reflector.getAllAndOverride<boolean>(ALLOW_MFA_SETUP, targets)
    ) {
      throw new ForbiddenException(MFA_SETUP_REQUIRED);
    }

    request.auth = auth;
    return true;
  }
}
