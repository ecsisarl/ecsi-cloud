import { ServiceUnavailableException } from '@nestjs/common';
import type { Env } from '../config/env.js';
import {
  deriveVoucherCode,
  keyForVersion,
  parseVersionedKeys,
  type VersionedKey,
  type VoucherCodeKeyring,
  voucherLookup,
} from './radius-keys.js';

export const VOUCHER_KEYS_MISSING = 'Clés de tickets non configurées';
export const VOUCHER_KEY_VERSION_MISSING =
  'Clé de réimpression absente pour ces tickets (rotation des clés)';

/**
 * Clés du lot B côté API (VOUCHER_CODE_KEY et RADIUS_VOUCHER_LOOKUP_KEY), lues une fois de
 * l'environnement. Sans elles, la génération et l'impression répondent 503 ; le reste de
 * l'API fonctionne. Les clés et les codes dérivés ne sont jamais journalisés : les erreurs ne
 * portent qu'un numéro de version.
 */
export class VoucherKeys {
  private readonly ring: VoucherCodeKeyring | null;
  private readonly lookup: VersionedKey | null;

  constructor(
    env: Pick<
      Env,
      | 'VOUCHER_CODE_KEY'
      | 'VOUCHER_CODE_KEY_VERSION'
      | 'VOUCHER_CODE_PREVIOUS_KEYS'
      | 'RADIUS_VOUCHER_LOOKUP_KEY'
      | 'RADIUS_VOUCHER_LOOKUP_KEY_VERSION'
    >,
  ) {
    if (env.VOUCHER_CODE_KEY && env.RADIUS_VOUCHER_LOOKUP_KEY) {
      this.ring = {
        active: { version: env.VOUCHER_CODE_KEY_VERSION, key: env.VOUCHER_CODE_KEY },
        previous: parseVersionedKeys(env.VOUCHER_CODE_PREVIOUS_KEYS),
      };
      this.lookup = {
        version: env.RADIUS_VOUCHER_LOOKUP_KEY_VERSION,
        key: env.RADIUS_VOUCHER_LOOKUP_KEY,
      };
    } else {
      this.ring = null;
      this.lookup = null;
    }
  }

  get configured(): boolean {
    return this.ring !== null && this.lookup !== null;
  }

  /** 503 « clés de tickets non configurées » si les clés manquent. */
  private keys(): { ring: VoucherCodeKeyring; lookup: VersionedKey } {
    if (!this.ring || !this.lookup) throw new ServiceUnavailableException(VOUCHER_KEYS_MISSING);
    return { ring: this.ring, lookup: this.lookup };
  }

  assertConfigured(): void {
    this.keys();
  }

  /** Versions inscrites dans un nouveau ticket. */
  versions(): { codeKeyVersion: number; lookupKeyVersion: number } {
    const { ring, lookup } = this.keys();
    return { codeKeyVersion: ring.active.version, lookupKeyVersion: lookup.version };
  }

  /** Nouveau ticket : code (clé active) et empreinte stockée en base. */
  issue(voucherId: string): { code: string; lookup: string } {
    const { ring, lookup } = this.keys();
    const code = deriveVoucherCode(ring.active.key, voucherId);
    return { code, lookup: voucherLookup(lookup.key, code) };
  }

  /** Code imprimable d'un ticket existant (réimpression), avec la version de clé qui l'a émis. */
  codeOf(voucherId: string, codeKeyVersion: number): string {
    const { ring } = this.keys();
    let key: string;
    try {
      key = keyForVersion(ring, codeKeyVersion);
    } catch {
      throw new ServiceUnavailableException(VOUCHER_KEY_VERSION_MISSING);
    }
    return deriveVoucherCode(key, voucherId);
  }
}
