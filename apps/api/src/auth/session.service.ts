import { Inject, Injectable, Logger } from '@nestjs/common';
import type { MfaState } from '@ecsi/shared';
import { and, eq, gt, isNull, ne, sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { AUTH_DRIZZLE, type Database } from '../database/database.module.js';
import {
  authSessions,
  companies,
  memberships,
  platformAdmins,
  refreshTokens,
  users,
} from '../database/schema/index.js';
import { REDIS } from '../redis/redis.module.js';
import { AccessTokenService } from './access-token.service.js';
import type { AuthContext, Realm, RequestMeta } from './auth.types.js';
import type { IssuedTokens } from './cookies.js';
import { generateOpaqueToken, hashToken } from './crypto/tokens.js';
import { SECRET_BOX } from './secret-box.provider.js';
import type { SecretBox } from './crypto/secret-box.js';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Durée de vie d'un refresh token (renouvelé à chaque rotation). */
export const REFRESH_TOKEN_TTL_MS = 14 * DAY_MS;
/** Durée maximale absolue d'une session, quelle que soit l'activité. */
export const SESSION_MAX_AGE_MS = 30 * DAY_MS;
/**
 * Fenêtre de tolérance après rotation : deux requêtes simultanées (plusieurs onglets) qui
 * présentent le même refresh token reçoivent le même successeur. Au-delà, la réutilisation
 * d'un ancien jeton est traitée comme un vol : la session entière est révoquée.
 */
export const REFRESH_REUSE_GRACE_MS = 30_000;
/** Fréquence maximale de mise à jour de last_used_at (évite une écriture par requête). */
const TOUCH_INTERVAL_MS = 5 * 60 * 1000;

export type RevokeReason =
  | 'LOGOUT'
  | 'USER_REVOKED'
  | 'REFRESH_TOKEN_REUSE'
  | 'PASSWORD_RESET'
  | 'MFA_ELEVATION'
  | 'OTHER_SESSIONS_REVOKED';

export interface NewSession {
  readonly realm: Realm;
  readonly principalId: string;
  readonly companyId: string | null;
  readonly mfaState: MfaState;
  readonly meta: RequestMeta;
}

export type RefreshResult =
  | { readonly ok: true; readonly tokens: IssuedTokens }
  | { readonly ok: false; readonly reason: 'UNKNOWN' | 'EXPIRED' | 'SESSION_ENDED' | 'REUSE' };

@Injectable()
export class SessionService {
  private readonly logger = new Logger(SessionService.name);

  constructor(
    @Inject(AUTH_DRIZZLE) private readonly db: Database,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(SECRET_BOX) private readonly secretBox: SecretBox,
    private readonly accessTokens: AccessTokenService,
  ) {}

  /**
   * Crée une NOUVELLE session (nouvel identifiant, nouveaux jetons) : appelée à chaque
   * connexion et à chaque élévation (2FA validée), ce qui empêche la fixation de session.
   */
  async create(input: NewSession): Promise<{ sessionId: string; tokens: IssuedTokens }> {
    const now = Date.now();
    const sessionExpiresAt = new Date(now + SESSION_MAX_AGE_MS);
    const refreshToken = generateOpaqueToken();
    const refreshExpiresAt = new Date(now + REFRESH_TOKEN_TTL_MS);

    const sessionId = await this.db.transaction(async (tx) => {
      const [session] = await tx
        .insert(authSessions)
        .values({
          userId: input.realm === 'user' ? input.principalId : null,
          platformAdminId: input.realm === 'platform' ? input.principalId : null,
          companyId: input.companyId,
          mfaState: input.mfaState,
          ip: input.meta.ip,
          userAgent: input.meta.userAgent,
          expiresAt: sessionExpiresAt,
        })
        .returning({ id: authSessions.id });
      if (!session) throw new Error('Création de session impossible');
      await tx.insert(refreshTokens).values({
        sessionId: session.id,
        tokenHash: hashToken(refreshToken),
        expiresAt: refreshExpiresAt,
      });
      return session.id;
    });

    const accessToken = await this.accessTokens.sign({
      sub: input.principalId,
      sid: sessionId,
      realm: input.realm,
    });
    return { sessionId, tokens: { accessToken, refreshToken, refreshExpiresAt } };
  }

  /** Rotation du refresh token, avec détection de réutilisation. */
  async refresh(rawToken: string): Promise<RefreshResult> {
    const tokenHash = hashToken(rawToken);
    const [row] = await this.db
      .select({
        tokenId: refreshTokens.id,
        tokenExpiresAt: refreshTokens.expiresAt,
        sessionId: authSessions.id,
        userId: authSessions.userId,
        platformAdminId: authSessions.platformAdminId,
        sessionExpiresAt: authSessions.expiresAt,
        revokedAt: authSessions.revokedAt,
      })
      .from(refreshTokens)
      .innerJoin(authSessions, eq(authSessions.id, refreshTokens.sessionId))
      .where(eq(refreshTokens.tokenHash, tokenHash))
      .limit(1);

    if (!row) return { ok: false, reason: 'UNKNOWN' };
    const now = Date.now();
    if (row.revokedAt || row.sessionExpiresAt.getTime() <= now) {
      return { ok: false, reason: 'SESSION_ENDED' };
    }
    if (row.tokenExpiresAt.getTime() <= now) return { ok: false, reason: 'EXPIRED' };

    const realm: Realm = row.userId ? 'user' : 'platform';
    const principalId = (row.userId ?? row.platformAdminId) as string;
    const successorKey = `rt:successor:${tokenHash.toString('hex')}`;
    const nextToken = generateOpaqueToken();
    const nextExpiresAt = new Date(
      Math.min(now + REFRESH_TOKEN_TTL_MS, row.sessionExpiresAt.getTime()),
    );

    const claimed = await this.db.transaction(async (tx) => {
      const [claim] = await tx
        .update(refreshTokens)
        .set({ usedAt: new Date(now) })
        .where(and(eq(refreshTokens.id, row.tokenId), isNull(refreshTokens.usedAt)))
        .returning({ id: refreshTokens.id });
      if (!claim) return false;
      await tx.insert(refreshTokens).values({
        sessionId: row.sessionId,
        tokenHash: hashToken(nextToken),
        expiresAt: nextExpiresAt,
      });
      await tx
        .update(authSessions)
        .set({ lastUsedAt: new Date(now) })
        .where(eq(authSessions.id, row.sessionId));
      return true;
    });

    if (claimed) {
      await this.redis.set(
        successorKey,
        this.secretBox.encrypt(
          JSON.stringify({ token: nextToken, expiresAt: nextExpiresAt.toISOString() }),
          successorKey,
        ),
        'PX',
        REFRESH_REUSE_GRACE_MS,
      );
      return {
        ok: true,
        tokens: await this.tokensFor(realm, principalId, row.sessionId, nextToken, nextExpiresAt),
      };
    }

    // Jeton déjà utilisé : requête concurrente légitime (fenêtre de tolérance) ou vol.
    const [used] = await this.db
      .select({ usedAt: refreshTokens.usedAt })
      .from(refreshTokens)
      .where(eq(refreshTokens.id, row.tokenId));
    const usedAt = used?.usedAt?.getTime() ?? 0;
    if (now - usedAt <= REFRESH_REUSE_GRACE_MS) {
      for (let attempt = 0; attempt < 10; attempt++) {
        const stored = await this.redis.get(successorKey);
        if (stored) {
          const successor = JSON.parse(this.secretBox.decrypt(stored, successorKey)) as {
            token: string;
            expiresAt: string;
          };
          return {
            ok: true,
            tokens: await this.tokensFor(
              realm,
              principalId,
              row.sessionId,
              successor.token,
              new Date(successor.expiresAt),
            ),
          };
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }

    await this.revoke(row.sessionId, 'REFRESH_TOKEN_REUSE');
    this.logger.warn(
      { event: 'auth.refresh_reuse_detected', sessionId: row.sessionId, realm },
      'Réutilisation d’un refresh token : session révoquée',
    );
    return { ok: false, reason: 'REUSE' };
  }

  private async tokensFor(
    realm: Realm,
    principalId: string,
    sessionId: string,
    refreshToken: string,
    refreshExpiresAt: Date,
  ): Promise<IssuedTokens> {
    const accessToken = await this.accessTokens.sign({ sub: principalId, sid: sessionId, realm });
    return { accessToken, refreshToken, refreshExpiresAt };
  }

  /**
   * Charge le contexte d'une session pour AuthGuard. Retourne null si la session est
   * révoquée ou expirée, si le compte est désactivé, ou si l'appartenance à l'entreprise
   * courante (ou l'entreprise elle-même) n'est plus active : l'effet est immédiat.
   */
  async loadContext(claims: {
    sid: string;
    sub: string;
    realm: Realm;
  }): Promise<AuthContext | null> {
    const now = new Date();
    const [session] = await this.db
      .select()
      .from(authSessions)
      .where(
        and(
          eq(authSessions.id, claims.sid),
          isNull(authSessions.revokedAt),
          gt(authSessions.expiresAt, now),
        ),
      )
      .limit(1);
    if (!session) return null;

    if (claims.realm === 'platform') {
      if (session.platformAdminId !== claims.sub) return null;
      const [admin] = await this.db
        .select({ status: platformAdmins.status })
        .from(platformAdmins)
        .where(eq(platformAdmins.id, claims.sub));
      if (admin?.status !== 'ACTIVE') return null;
    } else {
      if (session.userId !== claims.sub) return null;
      const [user] = await this.db
        .select({ status: users.status })
        .from(users)
        .where(and(eq(users.id, claims.sub), isNull(users.deletedAt)));
      if (user?.status !== 'ACTIVE') return null;
      if (session.companyId) {
        const [membership] = await this.db
          .select({ id: memberships.id })
          .from(memberships)
          .innerJoin(companies, eq(companies.id, memberships.companyId))
          .where(
            and(
              eq(memberships.companyId, session.companyId),
              eq(memberships.userId, claims.sub),
              eq(memberships.status, 'ACTIVE'),
              eq(companies.status, 'ACTIVE'),
              isNull(companies.deletedAt),
            ),
          );
        if (!membership) return null;
      }
    }

    if (now.getTime() - session.lastUsedAt.getTime() > TOUCH_INTERVAL_MS) {
      await this.db
        .update(authSessions)
        .set({ lastUsedAt: now })
        .where(eq(authSessions.id, session.id));
    }

    return {
      realm: claims.realm,
      sessionId: session.id,
      principalId: claims.sub,
      companyId: session.companyId,
      mfaState: session.mfaState as MfaState,
    };
  }

  async revoke(sessionId: string, reason: RevokeReason): Promise<void> {
    await this.db
      .update(authSessions)
      .set({ revokedAt: new Date(), revokedReason: reason })
      .where(and(eq(authSessions.id, sessionId), isNull(authSessions.revokedAt)));
  }

  /** Révoque toutes les sessions d'un principal, sauf éventuellement la session courante. */
  async revokeAll(
    realm: Realm,
    principalId: string,
    reason: RevokeReason,
    exceptSessionId?: string,
  ): Promise<number> {
    const owner =
      realm === 'user'
        ? eq(authSessions.userId, principalId)
        : eq(authSessions.platformAdminId, principalId);
    const result = await this.db
      .update(authSessions)
      .set({ revokedAt: new Date(), revokedReason: reason })
      .where(
        and(
          owner,
          isNull(authSessions.revokedAt),
          exceptSessionId ? ne(authSessions.id, exceptSessionId) : sql`true`,
        ),
      )
      .returning({ id: authSessions.id });
    return result.length;
  }

  /** Sessions actives du principal (page « Sessions actives »). */
  async listActive(realm: Realm, principalId: string) {
    const owner =
      realm === 'user'
        ? eq(authSessions.userId, principalId)
        : eq(authSessions.platformAdminId, principalId);
    return this.db
      .select({
        id: authSessions.id,
        ip: authSessions.ip,
        userAgent: authSessions.userAgent,
        createdAt: authSessions.createdAt,
        lastUsedAt: authSessions.lastUsedAt,
      })
      .from(authSessions)
      .where(and(owner, isNull(authSessions.revokedAt), gt(authSessions.expiresAt, new Date())))
      .orderBy(sql`${authSessions.lastUsedAt} desc`);
  }

  /** Révoque une session du principal ; false si elle ne lui appartient pas (aucune fuite). */
  async revokeOwned(realm: Realm, principalId: string, sessionId: string): Promise<boolean> {
    const owner =
      realm === 'user'
        ? eq(authSessions.userId, principalId)
        : eq(authSessions.platformAdminId, principalId);
    const result = await this.db
      .update(authSessions)
      .set({ revokedAt: new Date(), revokedReason: 'USER_REVOKED' })
      .where(and(eq(authSessions.id, sessionId), owner, isNull(authSessions.revokedAt)))
      .returning({ id: authSessions.id });
    return result.length > 0;
  }

  /** Déconnexion sans jeton d'accès valide : retrouve la session par son refresh token. */
  async revokeByRefreshToken(rawToken: string, reason: RevokeReason): Promise<void> {
    const [row] = await this.db
      .select({ sessionId: refreshTokens.sessionId })
      .from(refreshTokens)
      .where(eq(refreshTokens.tokenHash, hashToken(rawToken)));
    if (row) await this.revoke(row.sessionId, reason);
  }

  async setCompany(sessionId: string, companyId: string): Promise<void> {
    await this.db.update(authSessions).set({ companyId }).where(eq(authSessions.id, sessionId));
  }
}
