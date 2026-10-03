import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { REDIS } from '../redis/redis.module.js';
import type { Realm } from './auth.types.js';
import { MFA_CHALLENGE_TTL_SECONDS } from './cookies.js';
import { generateOpaqueToken } from './crypto/tokens.js';

export interface MfaChallenge {
  readonly realm: Realm;
  readonly principalId: string;
  readonly companyId: string | null;
}

/**
 * Étape intermédiaire de connexion : mot de passe vérifié, code 2FA attendu.
 * Aucune session n'existe tant que le code n'est pas validé (5 minutes, 5 essais).
 */
@Injectable()
export class MfaChallengeStore {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  async create(challenge: MfaChallenge): Promise<string> {
    const id = generateOpaqueToken();
    await this.redis.set(this.key(id), JSON.stringify(challenge), 'EX', MFA_CHALLENGE_TTL_SECONDS);
    return id;
  }

  async get(id: string): Promise<MfaChallenge | null> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(id)) return null;
    const raw = await this.redis.get(this.key(id));
    return raw ? (JSON.parse(raw) as MfaChallenge) : null;
  }

  async delete(id: string): Promise<void> {
    await this.redis.del(this.key(id));
  }

  private key(id: string) {
    return `mfa:challenge:${id}`;
  }
}
