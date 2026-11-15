import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { TooManyRequestsException } from '../common/errors.js';
import { ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';
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
  /**
   * Échecs de mot de passe pour un compte (existant ou non) DEPUIS UNE MÊME ADRESSE IP (ou
   * réseau /64 en IPv6) avant verrouillage temporaire de ce couple : un tiers ne verrouille
   * plus le compte pour tout le monde avec 5 essais.
   */
  loginFailuresPerEmail: { limit: 5, windowSeconds: 15 * 60 },
  /**
   * Plafond d'échecs pour un compte, TOUTES adresses confondues (attaque distribuée) : le
   * verrouiller exige alors au moins 10 adresses IP distinctes.
   */
  loginFailuresPerAccount: { limit: 50, windowSeconds: 15 * 60 },
  mfaPerIp: { limit: 30, windowSeconds: 15 * 60 },
  mfaAttemptsPerChallenge: { limit: 5, windowSeconds: 5 * 60 },
  /**
   * Codes 2FA invalides par compte, tous défis confondus : chaque connexion par mot de passe
   * ouvre un nouveau défi de 5 essais, ce plafond borne la force brute du code TOTP pour qui
   * connaît le mot de passe. Ne bloque que l'étape 2FA (le mot de passe est déjà connu).
   */
  mfaFailuresPerAccount: { limit: 10, windowSeconds: 60 * 60 },
  /** Confirmations 2FA et régénérations de codes de récupération (session ouverte). */
  mfaManagePerAccount: { limit: 10, windowSeconds: 15 * 60 },
  forgotPerEmail: { limit: 5, windowSeconds: 60 * 60 },
  forgotPerIp: { limit: 20, windowSeconds: 60 * 60 },
  /** Mots de passe invalides à l'acceptation d'une invitation (compte existant). */
  invitationPasswordFailures: { limit: 5, windowSeconds: 15 * 60 },
  logoutPerIp: { limit: 120, windowSeconds: 15 * 60 },
  resetPerIp: { limit: 20, windowSeconds: 60 * 60 },
  invitationPerIp: { limit: 30, windowSeconds: 60 * 60 },
  refreshPerIp: { limit: 300, windowSeconds: 15 * 60 },
  /** Enrôlement public des routeurs (POST /routers/enroll) ; plusieurs routeurs par CGNAT. */
  routerEnrollPerIp: { limit: 30, windowSeconds: 15 * 60 },
} as const satisfies Record<string, RateLimitRule>;

/**
 * Clé d'adresse IP pour la limitation : l'adresse IPv4 telle quelle, le réseau /64 en IPv6
 * (un client IPv6 dispose couramment de tout un /64 et changerait d'adresse à chaque essai).
 */
export function ipBucket(ip: string): string {
  const address = ip.trim().toLowerCase();
  if (!address.includes(':')) return address;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(address);
  if (mapped?.[1]) return mapped[1];
  const [head = '', tail = ''] = address.split('%')[0]?.split('::') ?? [];
  const left = head ? head.split(':') : [];
  const right = address.includes('::') && tail ? tail.split(':') : [];
  const missing = 8 - left.length - right.length;
  const groups = address.includes('::')
    ? [...left, ...Array<string>(Math.max(0, missing)).fill('0'), ...right]
    : left;
  const prefix = groups.slice(0, 4).map((group) => group.replace(/^0+(?=.)/, '') || '0');
  return `${prefix.join(':')}::/64`;
}

/**
 * Limiteur à fenêtre fixe dans Redis (INCR + EXPIRE atomiques). Partagé entre toutes
 * les instances de l'API ; les clés ne contiennent jamais d'adresse e-mail en clair.
 */
@Injectable()
export class RateLimiterService {
  /** Limite des connexions par IP (configurable : RATE_LIMIT_LOGIN_PER_IP). */
  readonly loginPerIp: RateLimitRule;

  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(ENV) env: Env,
  ) {
    this.loginPerIp = { ...RATE_LIMITS.loginPerIp, limit: env.RATE_LIMIT_LOGIN_PER_IP };
  }

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

  /**
   * Verrouillage des échecs de mot de passe (connexion entreprise « login », plateforme
   * « plogin ») : par couple compte + IP, et plafond par compte toutes IP confondues.
   * `accountKey` est une empreinte (jamais l'adresse e-mail en clair).
   */
  async assertLoginAllowed(scope: string, accountKey: string, ip: string): Promise<void> {
    await this.assertNotLimited(
      `${scope}:fail:${accountKey}:${ipBucket(ip)}`,
      RATE_LIMITS.loginFailuresPerEmail,
    );
    await this.assertNotLimited(`${scope}:fail:${accountKey}`, RATE_LIMITS.loginFailuresPerAccount);
  }

  async recordLoginFailure(scope: string, accountKey: string, ip: string): Promise<void> {
    await this.hit(
      `${scope}:fail:${accountKey}:${ipBucket(ip)}`,
      RATE_LIMITS.loginFailuresPerEmail,
    );
    await this.hit(`${scope}:fail:${accountKey}`, RATE_LIMITS.loginFailuresPerAccount);
  }

  /** Après un succès : le couple compte + IP est levé (le plafond global expire seul). */
  async clearLoginFailures(scope: string, accountKey: string, ip: string): Promise<void> {
    await this.reset(`${scope}:fail:${accountKey}:${ipBucket(ip)}`);
  }

  /** Réinitialisation du mot de passe par e-mail : tous les verrouillages du compte. */
  async clearAllLoginFailures(scope: string, accountKey: string): Promise<void> {
    let cursor = '0';
    const keys = [`rl:${scope}:fail:${accountKey}`];
    do {
      const [next, batch] = await this.redis.scan(
        cursor,
        'MATCH',
        `rl:${scope}:fail:${accountKey}:*`,
        'COUNT',
        200,
      );
      cursor = next;
      keys.push(...batch);
    } while (cursor !== '0');
    await this.redis.del(...keys);
  }
}
