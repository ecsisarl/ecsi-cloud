import { AUTH_COOKIES, API_PREFIX } from '@ecsi/shared';
import type { CookieSerializeOptions } from '@fastify/cookie';
import type { FastifyReply } from 'fastify';
import { generateOpaqueToken } from './crypto/tokens.js';
import { ACCESS_TOKEN_TTL_SECONDS } from './access-token.service.js';

export const MFA_CHALLENGE_TTL_SECONDS = 5 * 60;

export interface IssuedTokens {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly refreshExpiresAt: Date;
}

/**
 * Cookies d'authentification : httpOnly (inaccessibles au JavaScript, donc à une XSS),
 * SameSite=Strict (jamais envoyés par un site tiers), Secure en HTTPS.
 * Le cookie CSRF n'est pas httpOnly : le dashboard le recopie dans l'en-tête X-CSRF-Token.
 */
function base(secure: boolean): CookieSerializeOptions {
  return { path: '/', sameSite: 'strict', secure };
}

export function setAuthCookies(reply: FastifyReply, tokens: IssuedTokens, secure: boolean): void {
  const refreshMaxAge = Math.max(
    1,
    Math.floor((tokens.refreshExpiresAt.getTime() - Date.now()) / 1000),
  );
  void reply
    .setCookie(AUTH_COOKIES.access, tokens.accessToken, {
      ...base(secure),
      httpOnly: true,
      maxAge: ACCESS_TOKEN_TTL_SECONDS,
    })
    .setCookie(AUTH_COOKIES.refresh, tokens.refreshToken, {
      ...base(secure),
      httpOnly: true,
      maxAge: refreshMaxAge,
    })
    .setCookie(AUTH_COOKIES.csrf, generateOpaqueToken(), {
      ...base(secure),
      httpOnly: false,
      maxAge: refreshMaxAge,
    })
    .clearCookie(AUTH_COOKIES.mfaChallenge, mfaCookieOptions(secure));
}

export function clearAuthCookies(reply: FastifyReply, secure: boolean): void {
  for (const name of [AUTH_COOKIES.access, AUTH_COOKIES.refresh, AUTH_COOKIES.csrf]) {
    void reply.clearCookie(name, base(secure));
  }
  void reply.clearCookie(AUTH_COOKIES.mfaChallenge, mfaCookieOptions(secure));
}

function mfaCookieOptions(secure: boolean): CookieSerializeOptions {
  return { path: `/${API_PREFIX}`, sameSite: 'strict', secure, httpOnly: true };
}

export function setMfaChallengeCookie(reply: FastifyReply, challengeId: string, secure: boolean) {
  void reply.setCookie(AUTH_COOKIES.mfaChallenge, challengeId, {
    ...mfaCookieOptions(secure),
    maxAge: MFA_CHALLENGE_TTL_SECONDS,
  });
}
