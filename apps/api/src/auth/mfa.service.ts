import {
  ConflictException,
  Inject,
  Injectable,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { MfaVerifyRequest } from '@ecsi/shared';
import { MFA_REQUIRED_ROLES } from '@ecsi/shared';
import { and, eq, inArray, isNotNull, isNull, lt, or } from 'drizzle-orm';
import { AUTH_DRIZZLE, type Database } from '../database/database.module.js';
import {
  companies,
  membershipRoles,
  memberships,
  mfaFactors,
  mfaRecoveryCodes,
  roles,
} from '../database/schema/index.js';
import type { Realm } from './auth.types.js';
import type { SecretBox } from './crypto/secret-box.js';
import { generateRecoveryCodes, normalizeRecoveryCode } from './crypto/tokens.js';
import { generateTotpSecret, otpauthUri, verifyTotp } from './crypto/totp.js';
import { SECRET_BOX } from './secret-box.provider.js';

const INVALID_CODE = 'Code de vérification invalide';

/** Authentification à deux facteurs TOTP et codes de récupération, pour les deux realms. */
@Injectable()
export class MfaService {
  constructor(
    @Inject(AUTH_DRIZZLE) private readonly db: Database,
    @Inject(SECRET_BOX) private readonly secretBox: SecretBox,
  ) {}

  private owner(realm: Realm, principalId: string) {
    return realm === 'user'
      ? { column: mfaFactors.userId, values: { userId: principalId } }
      : { column: mfaFactors.platformAdminId, values: { platformAdminId: principalId } };
  }

  private recoveryOwner(realm: Realm, principalId: string) {
    return realm === 'user'
      ? eq(mfaRecoveryCodes.userId, principalId)
      : eq(mfaRecoveryCodes.platformAdminId, principalId);
  }

  /** Le secret est lié à son propriétaire (données associées AES-GCM) : un chiffré copié ailleurs est inutilisable. */
  private aad(realm: Realm, principalId: string) {
    return `mfa:${realm}:${principalId}`;
  }

  async isEnabled(realm: Realm, principalId: string): Promise<boolean> {
    const { column } = this.owner(realm, principalId);
    const [factor] = await this.db
      .select({ id: mfaFactors.id })
      .from(mfaFactors)
      .where(and(eq(column, principalId), isNotNull(mfaFactors.confirmedAt)));
    return Boolean(factor);
  }

  /**
   * 2FA obligatoire : toujours pour un super administrateur ; pour un utilisateur, dès qu'il
   * détient un rôle MFA_REQUIRED_ROLES (ADMIN_ENTREPRISE) dans l'une de ses entreprises actives.
   */
  async isRequired(realm: Realm, principalId: string): Promise<boolean> {
    if (realm === 'platform') return true;
    const [row] = await this.db
      .select({ id: membershipRoles.id })
      .from(membershipRoles)
      .innerJoin(memberships, eq(memberships.id, membershipRoles.membershipId))
      .innerJoin(roles, eq(roles.id, membershipRoles.roleId))
      .innerJoin(companies, eq(companies.id, memberships.companyId))
      .where(
        and(
          eq(memberships.userId, principalId),
          eq(memberships.status, 'ACTIVE'),
          eq(companies.status, 'ACTIVE'),
          eq(roles.isSystem, true),
          inArray(roles.code, [...MFA_REQUIRED_ROLES]),
        ),
      )
      .limit(1);
    return Boolean(row);
  }

  async startSetup(realm: Realm, principalId: string, accountName: string) {
    if (await this.isEnabled(realm, principalId)) {
      throw new ConflictException("L'authentification à deux facteurs est déjà activée");
    }
    const { column, values } = this.owner(realm, principalId);
    const secret = generateTotpSecret();
    await this.db.transaction(async (tx) => {
      await tx
        .delete(mfaFactors)
        .where(and(eq(column, principalId), isNull(mfaFactors.confirmedAt)));
      await tx.insert(mfaFactors).values({
        ...values,
        secretEnc: this.secretBox.encrypt(secret, this.aad(realm, principalId)),
      });
    });
    return { secret, otpauthUri: otpauthUri(secret, accountName) };
  }

  /** Valide le premier code, active la 2FA et retourne les codes de récupération (affichés une seule fois). */
  async confirmSetup(realm: Realm, principalId: string, code: string): Promise<string[]> {
    const { column } = this.owner(realm, principalId);
    const [factor] = await this.db
      .select()
      .from(mfaFactors)
      .where(and(eq(column, principalId), isNull(mfaFactors.confirmedAt)));
    if (!factor) throw new ConflictException('Aucune configuration 2FA en cours');
    const secret = this.secretBox.decrypt(factor.secretEnc, this.aad(realm, principalId));
    const step = verifyTotp(secret, code, Date.now(), null);
    if (step === null) throw new UnprocessableEntityException(INVALID_CODE);

    return this.db.transaction(async (tx) => {
      await tx
        .update(mfaFactors)
        .set({ confirmedAt: new Date(), lastUsedStep: step })
        .where(eq(mfaFactors.id, factor.id));
      return this.replaceRecoveryCodes(tx, realm, principalId);
    });
  }

  /** Vérifie un code TOTP (anti-rejeu) ou consomme un code de récupération (usage unique). */
  async verify(realm: Realm, principalId: string, input: MfaVerifyRequest): Promise<boolean> {
    if ('recoveryCode' in input) {
      const codeHash = this.secretBox.mac(normalizeRecoveryCode(input.recoveryCode));
      const used = await this.db
        .update(mfaRecoveryCodes)
        .set({ usedAt: new Date() })
        .where(
          and(
            this.recoveryOwner(realm, principalId),
            eq(mfaRecoveryCodes.codeHash, codeHash),
            isNull(mfaRecoveryCodes.usedAt),
          ),
        )
        .returning({ id: mfaRecoveryCodes.id });
      return used.length > 0;
    }

    const { column } = this.owner(realm, principalId);
    const [factor] = await this.db
      .select()
      .from(mfaFactors)
      .where(and(eq(column, principalId), isNotNull(mfaFactors.confirmedAt)));
    if (!factor) return false;
    const secret = this.secretBox.decrypt(factor.secretEnc, this.aad(realm, principalId));
    const step = verifyTotp(secret, input.code, Date.now(), factor.lastUsedStep);
    if (step === null) return false;
    // Mise à jour conditionnelle : deux requêtes simultanées avec le même code -> une seule réussit.
    const updated = await this.db
      .update(mfaFactors)
      .set({ lastUsedStep: step })
      .where(
        and(
          eq(mfaFactors.id, factor.id),
          or(isNull(mfaFactors.lastUsedStep), lt(mfaFactors.lastUsedStep, step)),
        ),
      )
      .returning({ id: mfaFactors.id });
    return updated.length > 0;
  }

  async regenerateRecoveryCodes(realm: Realm, principalId: string, code: string) {
    if (!(await this.verify(realm, principalId, { code }))) {
      throw new UnprocessableEntityException(INVALID_CODE);
    }
    return this.db.transaction((tx) => this.replaceRecoveryCodes(tx, realm, principalId));
  }

  async remainingRecoveryCodes(realm: Realm, principalId: string): Promise<number> {
    const rows = await this.db
      .select({ id: mfaRecoveryCodes.id })
      .from(mfaRecoveryCodes)
      .where(and(this.recoveryOwner(realm, principalId), isNull(mfaRecoveryCodes.usedAt)));
    return rows.length;
  }

  private async replaceRecoveryCodes(
    tx: Parameters<Parameters<Database['transaction']>[0]>[0],
    realm: Realm,
    principalId: string,
  ): Promise<string[]> {
    await tx.delete(mfaRecoveryCodes).where(this.recoveryOwner(realm, principalId));
    const codes = generateRecoveryCodes(10);
    await tx.insert(mfaRecoveryCodes).values(
      codes.map((code) => ({
        ...(realm === 'user' ? { userId: principalId } : { platformAdminId: principalId }),
        codeHash: this.secretBox.mac(normalizeRecoveryCode(code)),
      })),
    );
    return codes;
  }
}
