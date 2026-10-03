import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Post,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  AUTH_COOKIES,
  type LoginRequest,
  loginRequestSchema,
  type LoginResponse,
  mfaConfirmRequestSchema,
  type MfaSetupResponse,
  type MfaVerifyRequest,
  mfaVerifyRequestSchema,
  type RecoveryCodesResponse,
} from '@ecsi/shared';
import { eq } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { AuditService } from '../audit/audit.service.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { ENV } from '../config/config.module.js';
import { type Env, isCookieSecure } from '../config/env.js';
import { AUTH_DRIZZLE, type Database } from '../database/database.module.js';
import { platformAdmins } from '../database/schema/index.js';
import { AllowMfaSetup, CurrentAuth, PlatformRealm, Public, ReqMeta } from './auth.decorators.js';
import { AuthService, INVALID_CREDENTIALS } from './auth.service.js';
import type { AuthContext, RequestMeta } from './auth.types.js';
import { clearAuthCookies, setAuthCookies, setMfaChallengeCookie } from './cookies.js';
import { verifyAgainstDummy, verifyPassword } from './crypto/password.js';
import type { SecretBox } from './crypto/secret-box.js';
import { MfaService } from './mfa.service.js';
import { RATE_LIMITS, RateLimiterService } from './rate-limiter.service.js';
import { SECRET_BOX } from './secret-box.provider.js';

/**
 * Connexion des super administrateurs ECSI : /api/v1/platform/auth/*.
 * Espace distinct (table platform_admins, realm « platform ») : un compte d'entreprise ne
 * peut pas s'y connecter, et une session plateforme est refusée sur les routes d'entreprise.
 * La 2FA y est toujours obligatoire. Les connexions et actions plateforme sont auditées.
 */
@ApiTags('platform')
@PlatformRealm()
@Controller('platform/auth')
export class PlatformAuthController {
  private readonly secure: boolean;

  constructor(
    @Inject(ENV) env: Env,
    @Inject(AUTH_DRIZZLE) private readonly db: Database,
    @Inject(SECRET_BOX) private readonly secretBox: SecretBox,
    private readonly auth: AuthService,
    private readonly mfa: MfaService,
    private readonly rateLimiter: RateLimiterService,
    private readonly audit: AuditService,
  ) {
    this.secure = isCookieSecure(env);
  }

  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(
    @Body(new ZodValidationPipe(loginRequestSchema)) body: LoginRequest,
    @ReqMeta() meta: RequestMeta,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<LoginResponse> {
    const emailKey = this.secretBox.fingerprint(`platform:${body.email}`);
    await this.rateLimiter.consume(`plogin:ip:${meta.ip}`, RATE_LIMITS.loginPerIp);
    await this.rateLimiter.assertNotLimited(
      `plogin:fail:${emailKey}`,
      RATE_LIMITS.loginFailuresPerEmail,
    );

    const [admin] = await this.db
      .select({
        id: platformAdmins.id,
        status: platformAdmins.status,
        hash: platformAdmins.passwordHash,
      })
      .from(platformAdmins)
      .where(eq(platformAdmins.email, body.email));
    const valid = admin
      ? await verifyPassword(admin.hash, body.password)
      : await verifyAgainstDummy(body.password);
    if (!admin || !valid || admin.status !== 'ACTIVE') {
      await this.rateLimiter.hit(`plogin:fail:${emailKey}`, RATE_LIMITS.loginFailuresPerEmail);
      await this.audit.writeDirect(
        null,
        {
          action: 'platform.auth.login',
          resourceType: 'session',
          result: 'FAILURE',
          details: { emailFingerprint: emailKey },
        },
        admin ? await this.audit.principal('platform', admin.id) : { type: 'ANONYMOUS', id: null },
      );
      throw new UnauthorizedException(INVALID_CREDENTIALS);
    }
    await this.rateLimiter.reset(`plogin:fail:${emailKey}`);
    await this.db
      .update(platformAdmins)
      .set({ lastLoginAt: new Date() })
      .where(eq(platformAdmins.id, admin.id));

    const outcome = await this.auth.startSessionOrChallenge('platform', admin.id, null, meta);
    if (outcome.kind === 'mfa') {
      clearAuthCookies(reply, this.secure);
      setMfaChallengeCookie(reply, outcome.challengeId, this.secure);
      return { status: 'MFA_REQUIRED' };
    }
    setAuthCookies(reply, outcome.tokens, this.secure);
    return { status: 'AUTHENTICATED', mfaState: outcome.mfaState };
  }

  @Public()
  @Post('mfa/verify')
  @HttpCode(HttpStatus.OK)
  async verifyMfa(
    @Body(new ZodValidationPipe(mfaVerifyRequestSchema)) body: MfaVerifyRequest,
    @Req() request: FastifyRequest,
    @ReqMeta() meta: RequestMeta,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<LoginResponse> {
    const tokens = await this.auth.completeMfa(
      'platform',
      request.cookies[AUTH_COOKIES.mfaChallenge],
      body,
      meta,
    );
    setAuthCookies(reply, tokens, this.secure);
    return { status: 'AUTHENTICATED', mfaState: 'VERIFIED' };
  }

  @AllowMfaSetup()
  @Get('me')
  async me(@CurrentAuth() auth: AuthContext) {
    const [admin] = await this.db
      .select({
        id: platformAdmins.id,
        email: platformAdmins.email,
        fullName: platformAdmins.fullName,
      })
      .from(platformAdmins)
      .where(eq(platformAdmins.id, auth.principalId));
    return { realm: 'platform' as const, admin, mfa: { state: auth.mfaState } };
  }

  @AllowMfaSetup()
  @Post('mfa/setup')
  @HttpCode(HttpStatus.OK)
  async setupMfa(@CurrentAuth() auth: AuthContext): Promise<MfaSetupResponse> {
    const [admin] = await this.db
      .select({ email: platformAdmins.email })
      .from(platformAdmins)
      .where(eq(platformAdmins.id, auth.principalId));
    return this.mfa.startSetup('platform', auth.principalId, `plateforme:${admin?.email ?? ''}`);
  }

  @AllowMfaSetup()
  @Post('mfa/confirm')
  @HttpCode(HttpStatus.OK)
  async confirmMfa(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(mfaConfirmRequestSchema)) body: { code: string },
    @ReqMeta() meta: RequestMeta,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<RecoveryCodesResponse> {
    const { tokens, recoveryCodes } = await this.auth.confirmMfaSetup(auth, body.code, meta);
    setAuthCookies(reply, tokens, this.secure);
    return { recoveryCodes };
  }
}
