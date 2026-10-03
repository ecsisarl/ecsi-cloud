import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  UnauthorizedException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  type AcceptInvitationRequest,
  type InvitationPreview,
  type LoginRequest,
  type MeResponse,
  type MfaVerifyRequest,
  passwordSchema,
} from '@ecsi/shared';
import { and, asc, eq, gt, inArray, isNull } from 'drizzle-orm';
import { ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';
import { AUTH_DRIZZLE, type Database } from '../database/database.module.js';
import {
  companies,
  invitationRoles,
  invitations,
  membershipRoleSites,
  membershipRoles,
  memberships,
  passwordResetTokens,
  sites,
  userCredentials,
  users,
} from '../database/schema/index.js';
import { invitationMail, mfaResetMail, passwordResetMail } from '../mail/templates.js';
import { MailService } from '../mail/mail.service.js';
import { AuditService } from '../audit/audit.service.js';
import { AccessService } from '../tenancy/access.service.js';
import { TenantDatabase } from '../tenancy/tenant-database.js';
import type { AuthContext, Realm, RequestMeta } from './auth.types.js';
import type { IssuedTokens } from './cookies.js';
import { hashPassword, verifyAgainstDummy, verifyPassword } from './crypto/password.js';
import type { SecretBox } from './crypto/secret-box.js';
import { generateOpaqueToken, hashToken } from './crypto/tokens.js';
import { MfaChallengeStore } from './mfa-challenge.store.js';
import { MfaService } from './mfa.service.js';
import { RATE_LIMITS, RateLimiterService } from './rate-limiter.service.js';
import { SECRET_BOX } from './secret-box.provider.js';
import { SessionService } from './session.service.js';

export const INVALID_CREDENTIALS = 'Adresse e-mail ou mot de passe incorrect';
const INVALID_LINK = 'Lien invalide ou expiré';
const INVALID_INVITATION = 'Invitation invalide ou expirée';
export const PASSWORD_RESET_TTL_MS = 30 * 60 * 1000;
export const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type LoginOutcome =
  | {
      readonly kind: 'session';
      readonly tokens: IssuedTokens;
      readonly mfaState: 'NOT_REQUIRED' | 'SETUP_REQUIRED' | 'VERIFIED';
    }
  | { readonly kind: 'mfa'; readonly challengeId: string };

/**
 * Authentification des utilisateurs des entreprises (realm « user ») avec le rôle ecsi_auth.
 * Les messages d'erreur sont volontairement génériques : ils ne révèlent jamais si une
 * adresse possède un compte (énumération).
 */
@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(AUTH_DRIZZLE) private readonly db: Database,
    @Inject(SECRET_BOX) private readonly secretBox: SecretBox,
    private readonly sessions: SessionService,
    private readonly mfa: MfaService,
    private readonly challenges: MfaChallengeStore,
    private readonly rateLimiter: RateLimiterService,
    private readonly mail: MailService,
    private readonly tenantDb: TenantDatabase,
    private readonly access: AccessService,
    private readonly audit: AuditService,
  ) {}

  async login(input: LoginRequest, meta: RequestMeta): Promise<LoginOutcome> {
    const emailKey = this.secretBox.fingerprint(input.email);
    await this.rateLimiter.consume(`login:ip:${meta.ip}`, RATE_LIMITS.loginPerIp);
    await this.rateLimiter.assertNotLimited(
      `login:fail:${emailKey}`,
      RATE_LIMITS.loginFailuresPerEmail,
    );

    const [account] = await this.db
      .select({ id: users.id, status: users.status, passwordHash: userCredentials.passwordHash })
      .from(users)
      .leftJoin(userCredentials, eq(userCredentials.userId, users.id))
      .where(and(eq(users.email, input.email), isNull(users.deletedAt)))
      .limit(1);

    const valid = account?.passwordHash
      ? await verifyPassword(account.passwordHash, input.password)
      : await verifyAgainstDummy(input.password);

    if (!account || !valid || account.status !== 'ACTIVE') {
      await this.rateLimiter.hit(`login:fail:${emailKey}`, RATE_LIMITS.loginFailuresPerEmail);
      this.logger.warn({ event: 'auth.login_failed', emailKey, ip: meta.ip }, 'Échec de connexion');
      // Compte connu : l'échec lui est attribué ; sinon acteur anonyme, adresse pseudonymisée.
      await this.audit.writeDirect(
        null,
        {
          action: 'auth.login',
          resourceType: 'session',
          result: 'FAILURE',
          details: { emailFingerprint: emailKey, accountStatus: account ? account.status : null },
        },
        account ? await this.audit.principal('user', account.id) : { type: 'ANONYMOUS', id: null },
      );
      throw new UnauthorizedException(INVALID_CREDENTIALS);
    }

    await this.rateLimiter.reset(`login:fail:${emailKey}`);
    await this.db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, account.id));
    const companyId = await this.defaultCompany(account.id);
    this.logger.log(
      { event: 'auth.login_password_ok', userId: account.id },
      'Mot de passe vérifié',
    );
    return this.startSessionOrChallenge('user', account.id, companyId, meta);
  }

  /** Après vérification du mot de passe : défi 2FA si activée, sinon nouvelle session. */
  async startSessionOrChallenge(
    realm: Realm,
    principalId: string,
    companyId: string | null,
    meta: RequestMeta,
  ): Promise<LoginOutcome> {
    if (await this.mfa.isEnabled(realm, principalId)) {
      const challengeId = await this.challenges.create({ realm, principalId, companyId });
      return { kind: 'mfa', challengeId };
    }
    const mfaState = (await this.mfa.isRequired(realm, principalId))
      ? 'SETUP_REQUIRED'
      : 'NOT_REQUIRED';
    const { sessionId, tokens } = await this.sessions.create({
      realm,
      principalId,
      companyId,
      mfaState,
      meta,
    });
    await this.audit.writeDirect(
      realm === 'user' ? companyId : null,
      {
        action: realm === 'platform' ? 'platform.auth.login' : 'auth.login',
        resourceType: 'session',
        resourceId: sessionId,
        details: { mfaState },
      },
      await this.audit.principal(realm, principalId),
    );
    return { kind: 'session', tokens, mfaState };
  }

  /** Deuxième étape de connexion : code TOTP ou code de récupération. */
  async completeMfa(
    realm: Realm,
    challengeId: string | undefined,
    input: MfaVerifyRequest,
    meta: RequestMeta,
  ): Promise<IssuedTokens> {
    await this.rateLimiter.consume(`mfa:ip:${meta.ip}`, RATE_LIMITS.mfaPerIp);
    const challenge = challengeId ? await this.challenges.get(challengeId) : null;
    if (!challengeId || !challenge || challenge.realm !== realm) {
      throw new UnauthorizedException('Vérification expirée : reconnectez-vous');
    }
    const attempts = await this.rateLimiter.hit(
      `mfa:challenge:${challengeId}`,
      RATE_LIMITS.mfaAttemptsPerChallenge,
    );
    if (attempts.count > RATE_LIMITS.mfaAttemptsPerChallenge.limit) {
      await this.challenges.delete(challengeId);
      throw new UnauthorizedException('Trop de codes invalides : reconnectez-vous');
    }
    const method = 'recoveryCode' in input ? 'RECOVERY_CODE' : 'TOTP';
    const actor = await this.audit.principal(realm, challenge.principalId);
    const auditCompany = realm === 'user' ? challenge.companyId : null;
    if (!(await this.mfa.verify(realm, challenge.principalId, input))) {
      this.logger.warn(
        { event: 'auth.mfa_failed', realm, principalId: challenge.principalId, ip: meta.ip },
        'Code 2FA invalide',
      );
      await this.audit.writeDirect(
        auditCompany,
        {
          action: realm === 'platform' ? 'platform.auth.mfa_verify' : 'auth.mfa_verify',
          resourceType: 'session',
          result: 'FAILURE',
          details: { method },
        },
        actor,
      );
      throw new UnauthorizedException('Code de vérification invalide');
    }
    await this.challenges.delete(challengeId);
    const { sessionId, tokens } = await this.sessions.create({
      realm,
      principalId: challenge.principalId,
      companyId: challenge.companyId,
      mfaState: 'VERIFIED',
      meta,
    });
    await this.audit.writeDirect(
      auditCompany,
      {
        action: realm === 'platform' ? 'platform.auth.login' : 'auth.login',
        resourceType: 'session',
        resourceId: sessionId,
        details: { mfaState: 'VERIFIED', method },
      },
      actor,
    );
    return tokens;
  }

  /**
   * Activation de la 2FA depuis une session : la session courante est remplacée par une
   * nouvelle session « VERIFIED » (changement de privilège -> nouvel identifiant).
   */
  async confirmMfaSetup(auth: AuthContext, code: string, meta: RequestMeta) {
    const recoveryCodes = await this.mfa.confirmSetup(auth.realm, auth.principalId, code);
    await this.sessions.revoke(auth.sessionId, 'MFA_ELEVATION');
    const { tokens } = await this.sessions.create({
      realm: auth.realm,
      principalId: auth.principalId,
      companyId: auth.companyId,
      mfaState: 'VERIFIED',
      meta,
    });
    this.logger.log(
      { event: 'auth.mfa_enabled', realm: auth.realm, principalId: auth.principalId },
      '2FA activée',
    );
    await this.audit.writeDirect(
      auth.realm === 'user' ? auth.companyId : null,
      { action: 'auth.mfa_enable', resourceType: 'mfa', resourceId: auth.principalId },
      await this.audit.principal(auth.realm, auth.principalId),
    );
    return { tokens, recoveryCodes };
  }

  async me(auth: AuthContext): Promise<MeResponse> {
    const [user] = await this.db
      .select({ id: users.id, email: users.email, fullName: users.fullName, locale: users.locale })
      .from(users)
      .where(eq(users.id, auth.principalId));
    if (!user) throw new UnauthorizedException();
    const companyList = await this.activeCompanies(auth.principalId);
    const company = companyList.find((c) => c.id === auth.companyId) ?? null;

    let grantedRoles: string[] = [];
    let granted: string[] = [];
    if (company) {
      const tenant = { companyId: company.id, userId: auth.principalId };
      const grants = await this.tenantDb.run(tenant, (tx) => this.access.resolve(tx, tenant));
      grantedRoles = [...grants.roles];
      granted = grants.all();
    }
    return {
      realm: 'user',
      user,
      company,
      companies: companyList,
      roles: grantedRoles,
      permissions: granted,
      mfa: {
        enabled: await this.mfa.isEnabled('user', auth.principalId),
        required: await this.mfa.isRequired('user', auth.principalId),
        state: auth.mfaState,
      },
    };
  }

  /** Change l'entreprise courante, uniquement vers une entreprise dont l'utilisateur est membre actif. */
  async switchCompany(auth: AuthContext, companyId: string): Promise<void> {
    const allowed = await this.activeCompanies(auth.principalId);
    if (!allowed.some((company) => company.id === companyId)) {
      throw new ForbiddenException('Accès refusé');
    }
    await this.sessions.setCompany(auth.sessionId, companyId);
    await this.audit.writeDirect(
      companyId,
      { action: 'auth.switch_company', resourceType: 'session', resourceId: auth.sessionId },
      await this.audit.principal('user', auth.principalId),
    );
  }

  private async activeCompanies(userId: string) {
    return this.db
      .select({ id: companies.id, name: companies.name, slug: companies.slug })
      .from(memberships)
      .innerJoin(companies, eq(companies.id, memberships.companyId))
      .where(
        and(
          eq(memberships.userId, userId),
          eq(memberships.status, 'ACTIVE'),
          eq(companies.status, 'ACTIVE'),
          isNull(companies.deletedAt),
        ),
      )
      .orderBy(asc(memberships.createdAt));
  }

  private async defaultCompany(userId: string): Promise<string | null> {
    const [first] = await this.activeCompanies(userId);
    return first?.id ?? null;
  }

  /** Demande de réinitialisation : réponse identique que le compte existe ou non. */
  async forgotPassword(email: string, meta: RequestMeta): Promise<void> {
    const emailKey = this.secretBox.fingerprint(email);
    await this.rateLimiter.consume(`forgot:ip:${meta.ip}`, RATE_LIMITS.forgotPerIp);
    await this.rateLimiter.consume(`forgot:email:${emailKey}`, RATE_LIMITS.forgotPerEmail);

    const [user] = await this.db
      .select({ id: users.id, email: users.email, locale: users.locale })
      .from(users)
      .where(and(eq(users.email, email), eq(users.status, 'ACTIVE'), isNull(users.deletedAt)));
    if (!user) {
      this.logger.log(
        { event: 'auth.password_reset_unknown', emailKey },
        'Réinitialisation demandée',
      );
      return;
    }

    const token = generateOpaqueToken();
    await this.db.transaction(async (tx) => {
      // Un seul lien valide à la fois : les précédents sont invalidés.
      await tx
        .update(passwordResetTokens)
        .set({ usedAt: new Date() })
        .where(and(eq(passwordResetTokens.userId, user.id), isNull(passwordResetTokens.usedAt)));
      await tx.insert(passwordResetTokens).values({
        userId: user.id,
        tokenHash: hashToken(token),
        expiresAt: new Date(Date.now() + PASSWORD_RESET_TTL_MS),
      });
    });
    const url = `${this.env.WEB_PUBLIC_URL}/reinitialisation?token=${token}`;
    this.mail.sendInBackground(
      passwordResetMail(user.email, url, user.locale === 'en' ? 'en' : 'fr'),
      'password_reset',
    );
    this.logger.log(
      { event: 'auth.password_reset_requested', userId: user.id },
      'Réinitialisation demandée',
    );
    await this.audit.writeDirect(
      null,
      { action: 'auth.password_reset_request', resourceType: 'user', resourceId: user.id },
      await this.audit.principal('user', user.id),
    );
  }

  /** Réinitialisation : jeton à usage unique, 30 minutes ; toutes les sessions sont révoquées. */
  async resetPassword(token: string, password: string, meta: RequestMeta): Promise<void> {
    await this.rateLimiter.consume(`reset:ip:${meta.ip}`, RATE_LIMITS.resetPerIp);
    const passwordHash = await hashPassword(password);
    const userId = await this.db.transaction(async (tx) => {
      const [claimed] = await tx
        .update(passwordResetTokens)
        .set({ usedAt: new Date() })
        .where(
          and(
            eq(passwordResetTokens.tokenHash, hashToken(token)),
            isNull(passwordResetTokens.usedAt),
            gt(passwordResetTokens.expiresAt, new Date()),
          ),
        )
        .returning({ userId: passwordResetTokens.userId });
      if (!claimed) return null;
      await tx
        .insert(userCredentials)
        .values({ userId: claimed.userId, passwordHash })
        .onConflictDoUpdate({
          target: userCredentials.userId,
          set: { passwordHash, passwordChangedAt: new Date() },
        });
      return claimed.userId;
    });
    if (!userId) throw new BadRequestException(INVALID_LINK);

    const revoked = await this.sessions.revokeAll('user', userId, 'PASSWORD_RESET');
    const [user] = await this.db
      .select({ email: users.email })
      .from(users)
      .where(eq(users.id, userId));
    if (user) await this.rateLimiter.reset(`login:fail:${this.secretBox.fingerprint(user.email)}`);
    this.logger.log(
      { event: 'auth.password_reset_completed', userId, revokedSessions: revoked },
      'Mot de passe réinitialisé',
    );
    await this.audit.writeDirect(
      null,
      {
        action: 'auth.password_reset',
        resourceType: 'user',
        resourceId: userId,
        details: { revokedSessions: revoked },
      },
      await this.audit.principal('user', userId),
    );
  }

  async previewInvitation(token: string, meta: RequestMeta): Promise<InvitationPreview> {
    await this.rateLimiter.consume(`invitation:ip:${meta.ip}`, RATE_LIMITS.invitationPerIp);
    const invitation = await this.findUsableInvitation(token);
    const [existing] = await this.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, invitation.email));
    return {
      companyName: invitation.companyName,
      email: invitation.email,
      existingAccount: Boolean(existing),
      expiresAt: invitation.expiresAt.toISOString(),
    };
  }

  /**
   * Acceptation : crée le compte (ou vérifie le mot de passe du compte existant), puis
   * l'appartenance et les rôles prévus par l'invitation. L'utilisateur se connecte ensuite
   * normalement (avec 2FA si son rôle l'exige).
   */
  async acceptInvitation(input: AcceptInvitationRequest, meta: RequestMeta): Promise<void> {
    await this.rateLimiter.consume(`invitation:ip:${meta.ip}`, RATE_LIMITS.invitationPerIp);
    const invitation = await this.findUsableInvitation(input.token);

    const [existing] = await this.db
      .select({ id: users.id, status: users.status, passwordHash: userCredentials.passwordHash })
      .from(users)
      .leftJoin(userCredentials, eq(userCredentials.userId, users.id))
      .where(eq(users.email, invitation.email));

    let newAccount: { fullName: string; passwordHash: string } | null = null;
    if (existing) {
      const valid = existing.passwordHash
        ? await verifyPassword(existing.passwordHash, input.password)
        : false;
      if (!valid || existing.status !== 'ACTIVE') {
        throw new UnauthorizedException('Mot de passe incorrect');
      }
    } else {
      if (!input.fullName) throw new UnprocessableEntityException('Le nom complet est requis');
      const password = passwordSchema.safeParse(input.password);
      if (!password.success) {
        throw new UnprocessableEntityException(
          'Le mot de passe doit contenir au moins 12 caractères',
        );
      }
      newAccount = { fullName: input.fullName, passwordHash: await hashPassword(password.data) };
    }

    const userId = await this.db.transaction(async (tx) => {
      const [locked] = await tx
        .select({ status: invitations.status, expiresAt: invitations.expiresAt })
        .from(invitations)
        .where(eq(invitations.id, invitation.id))
        .for('update');
      if (locked?.status !== 'PENDING' || locked.expiresAt.getTime() <= Date.now()) {
        throw new BadRequestException(INVALID_INVITATION);
      }

      let id = existing?.id;
      if (!id && newAccount) {
        const [created] = await tx
          .insert(users)
          .values({ email: invitation.email, fullName: newAccount.fullName })
          .returning({ id: users.id });
        if (!created) throw new Error('Création du compte impossible');
        id = created.id;
        await tx
          .insert(userCredentials)
          .values({ userId: id, passwordHash: newAccount.passwordHash });
      }
      if (!id) throw new Error('Compte introuvable');

      const [already] = await tx
        .select({ id: memberships.id })
        .from(memberships)
        .where(and(eq(memberships.companyId, invitation.companyId), eq(memberships.userId, id)));
      if (already) throw new ConflictException('Ce compte est déjà membre de cette entreprise');

      const [membership] = await tx
        .insert(memberships)
        .values({ companyId: invitation.companyId, userId: id })
        .returning({ id: memberships.id });
      if (!membership) throw new Error('Création de l’appartenance impossible');

      const grants = await tx
        .select()
        .from(invitationRoles)
        .where(eq(invitationRoles.invitationId, invitation.id));
      for (const grant of grants) {
        const [assignment] = await tx
          .insert(membershipRoles)
          .values({
            companyId: invitation.companyId,
            membershipId: membership.id,
            roleId: grant.roleId,
            scope: grant.scope,
          })
          .returning({ id: membershipRoles.id });
        if (!assignment || grant.scope !== 'SITES') continue;
        // Sites encore existants (un site a pu être supprimé depuis l'invitation).
        const stillValid = grant.siteIds.length
          ? await tx
              .select({ id: sites.id })
              .from(sites)
              .where(
                and(
                  eq(sites.companyId, invitation.companyId),
                  inArray(sites.id, grant.siteIds),
                  isNull(sites.deletedAt),
                ),
              )
          : [];
        if (stillValid.length === 0) {
          // Rôle limité à des sites qui n'existent plus : il n'est pas attribué.
          await tx.delete(membershipRoles).where(eq(membershipRoles.id, assignment.id));
          continue;
        }
        await tx.insert(membershipRoleSites).values(
          stillValid.map((site) => ({
            companyId: invitation.companyId,
            membershipRoleId: assignment.id,
            siteId: site.id,
          })),
        );
      }

      await tx
        .update(invitations)
        .set({ status: 'ACCEPTED', acceptedAt: new Date(), acceptedUserId: id })
        .where(eq(invitations.id, invitation.id));
      return id;
    });

    this.logger.log(
      {
        event: 'auth.invitation_accepted',
        userId,
        companyId: invitation.companyId,
        newAccount: !existing,
      },
      'Invitation acceptée',
    );
    await this.audit.writeDirect(
      invitation.companyId,
      {
        action: 'invitations.accept',
        resourceType: 'invitation',
        resourceId: invitation.id,
        details: { userId, newAccount: !existing },
      },
      await this.audit.principal('user', userId),
    );
  }

  private async findUsableInvitation(token: string) {
    const [invitation] = await this.db
      .select({
        id: invitations.id,
        companyId: invitations.companyId,
        email: invitations.email,
        status: invitations.status,
        expiresAt: invitations.expiresAt,
        companyName: companies.name,
        companyStatus: companies.status,
      })
      .from(invitations)
      .innerJoin(companies, eq(companies.id, invitations.companyId))
      .where(eq(invitations.tokenHash, hashToken(token)));
    if (
      invitation?.status !== 'PENDING' ||
      invitation.expiresAt.getTime() <= Date.now() ||
      invitation.companyStatus !== 'ACTIVE'
    ) {
      throw new BadRequestException(INVALID_INVITATION);
    }
    return invitation;
  }

  /** Envoie l'e-mail d'invitation (appelé par le module Utilisateurs après création). */
  /** Informe l'utilisateur que sa 2FA a été réinitialisée (sécurité). */
  sendMfaResetMail(email: string, resetBy: string, locale: string): void {
    this.mail.sendInBackground(
      mfaResetMail(
        email,
        `${this.env.WEB_PUBLIC_URL}/connexion`,
        resetBy,
        locale === 'en' ? 'en' : 'fr',
      ),
      'mfa_reset',
    );
  }

  sendInvitationMail(email: string, token: string, companyName: string, inviterName: string): void {
    const url = `${this.env.WEB_PUBLIC_URL}/invitation?token=${token}`;
    this.mail.sendInBackground(
      invitationMail(email, url, companyName, inviterName, 'fr'),
      'invitation',
    );
  }
}
