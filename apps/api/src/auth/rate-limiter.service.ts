import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { TooManyRequestsException } from '../common/errors.js';
import { REDIS } from '../redis/redis.module.js';

export interface RateLimitRule {
  /** Nombre d'événements autorisés dans la fenêtre. */
  readonly limit: number;
  readonly windowSeconds: number;
}

export interface RateLimitState {
  readonly count: number;
  readonly retryAfterSeconds: number;
}

/** Règles de limitation des points d'entrée sensibles (docs/SECURITY.md). */
export const RATE_LIMITS = {
  loginPerIp: { limit: 20, windowSeconds: 15 * 60 },
  /** Échecs par adresse (existante ou non) avant verrouillage temporaire. */
  loginFailuresPerEmail: { limit: 5, windowSeconds: 15 * 60 },
  mfaPerIp: { limit: 30, windowSeconds: 15 * 60 },
  mfaAttemptsPerChallenge: { limit: 5, windowSeconds: 5 * 60 },
  forgotPerEmail: { limit: 5, windowSeconds: 60 * 60 },
  forgotPerIp: { limit: 20, windowSeconds: 60 * 60 },
  resetPerIp: { limit: 20, windowSeconds: 60 * 60 },
  invitationPerIp: { limit: 30, windowSeconds: 60 * 60 },
  refreshPerIp: { limit: 300, windowSeconds: 15 * 60 },
} as const satisfies Record<string, RateLimitRule>;

/**
 * Limiteur à fenêtre fixe dans Redis (INCR + EXPIRE atomiques). Partagé entre toutes
 * les instances de l'API ; les clés ne contiennent jamais d'adresse e-mail en clair.
 */
@Injectable()
export class RateLimiterService {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  /** Compte un événement et lève 429 si la limite est dépassée. */
  async consume(key: string, rule: RateLimitRule): Promise<void> {
    const state = await this.hit(key, rule);
    if (state.count > rule.limit) {
      throw new TooManyRequestsException(state.retryAfterSeconds);
    }
  }

  async hit(key: string, rule: RateLimitRule): Promise<RateLimitState> {
    const fullKey = `rl:${key}`;
    const results = await this.redis
      .multi()
      .incr(fullKey)
      .expire(fullKey, rule.windowSeconds, 'NX')
      .ttl(fullKey)
      .exec();
    const count = Number(results?.[0]?.[1] ?? 0);
    const ttl = Number(results?.[2]?.[1] ?? rule.windowSeconds);
    return { count, retryAfterSeconds: Math.max(1, ttl) };
  }

  /** Lève 429 si la limite est déjà atteinte, sans compter d'événement. */
  async assertNotLimited(key: string, rule: RateLimitRule): Promise<void> {
    const fullKey = `rl:${key}`;
    const [count, ttl] = await Promise.all([this.redis.get(fullKey), this.redis.ttl(fullKey)]);
    if (Number(count ?? 0) >= rule.limit) {
      throw new TooManyRequestsException(Math.max(1, ttl));
    }
  }

  async reset(key: string): Promise<void> {
    await this.redis.del(`rl:${key}`);
  }
}
