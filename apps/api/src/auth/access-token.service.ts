import { Inject, Injectable } from '@nestjs/common';
import { jwtVerify, SignJWT } from 'jose';
import { ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';
import type { Realm } from './auth.types.js';

export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
const ISSUER = 'ecsi-cloud';
const AUDIENCE = 'ecsi-api';

export interface AccessTokenClaims {
  readonly sub: string;
  readonly sid: string;
  readonly realm: Realm;
}

/**
 * Jeton d'accès court (15 min), HS256. Il ne porte que l'identité de la session ;
 * l'entreprise courante, l'état 2FA et la révocation sont relus en base à chaque requête.
 */
@Injectable()
export class AccessTokenService {
  private readonly key: Uint8Array;

  constructor(@Inject(ENV) env: Env) {
    this.key = new TextEncoder().encode(env.JWT_ACCESS_SECRET);
  }

  sign(claims: AccessTokenClaims): Promise<string> {
    return new SignJWT({ sid: claims.sid, realm: claims.realm })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject(claims.sub)
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt()
      .setExpirationTime(`${ACCESS_TOKEN_TTL_SECONDS}s`)
      .sign(this.key);
  }

  async verify(token: string): Promise<AccessTokenClaims | null> {
    try {
      const { payload } = await jwtVerify(token, this.key, {
        algorithms: ['HS256'],
        issuer: ISSUER,
        audience: AUDIENCE,
      });
      const { sub, sid, realm } = payload;
      if (
        typeof sub !== 'string' ||
        typeof sid !== 'string' ||
        (realm !== 'user' && realm !== 'platform')
      ) {
        return null;
      }
      return { sub, sid, realm };
    } catch {
      return null;
    }
  }
}
