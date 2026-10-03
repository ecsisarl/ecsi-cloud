import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  type AcceptInvitationRequest,
  acceptInvitationRequestSchema,
  AUTH_COOKIES,
  forgotPasswordRequestSchema,
  type InvitationPreview,
  type LoginRequest,
  loginRequestSchema,
  type LoginResponse,
  type MeResponse,
  mfaConfirmRequestSchema,
  type MfaSetupResponse,
  type MfaVerifyRequest,
  mfaVerifyRequestSchema,
  opaqueTokenSchema,
  type RecoveryCodesResponse,
  resetPasswordRequestSchema,
  type SessionSummary,
  switchCompanyRequestSchema,
} from '@ecsi/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { Audited } from '../audit/audit.interceptor.js';
import { AuditService } from '../audit/audit.service.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { ENV } from '../config/config.module.js';
import { type Env, isCookieSecure } from '../config/env.js';
import { AUTH_DRIZZLE, type Database } from '../database/database.module.js';
import { users } from '../database/schema/index.js';
import { AccessTokenService } from './access-token.service.js';
import { AllowMfaSetup, CurrentAuth, Public, ReqMeta } from './auth.decorators.js';
import { AuthService } from './auth.service.js';
import type { AuthContext, RequestMeta } from './auth.types.js';
import { clearAuthCookies, setAuthCookies, setMfaChallengeCookie } from './cookies.js';
import { MfaService } from './mfa.service.js';
import { SessionService } from './session.service.js';
import { RATE_LIMITS, RateLimiterService } from './rate-limiter.service.js';

/** Authentification des utilisateurs des entreprises : /api/v1/auth/*. */
@ApiTags('auth')
@Controller('auth')
export class AuthController {
  private readonly secure: boolean;

  constructor(
    @Inject(ENV) env: Env,
    @Inject(AUTH_DRIZZLE) private readonly db: Database,
    private readonly auth: AuthService,
    private readonly sessions: SessionService,
    private readonly mfa: MfaService,
    private readonly accessTokens: AccessTokenService,
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
    const outcome = await this.auth.login(body, meta);
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
      'user',
      request.cookies[AUTH_COOKIES.mfaChallenge],
      body,
      meta,
    );
    setAuthCookies(reply, tokens, this.secure);
    return { status: 'AUTHENTICATED', mfaState: 'VERIFIED' };
  }

  /** Rotation du refresh token (cookie httpOnly). Commun aux deux realms. */
  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.NO_CONTENT)
  async refresh(
    @Req() request: FastifyRequest,
    @ReqMeta() meta: RequestMeta,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<void> {
    await this.rateLimiter.consume(`refresh:ip:${meta.ip}`, RATE_LIMITS.refreshPerIp);
    const raw = request.cookies[AUTH_COOKIES.refresh];
    const result = raw ? await this.sessions.refresh(raw) : null;
    if (!result?.ok) {
      clearAuthCookies(reply, this.secure);
      throw new UnauthorizedException('Session expirée');
    }
    setAuthCookies(reply, result.tokens, this.secure);
  }

  /** Déconnexion : révoque la session côté serveur, même si le jeton d'accès a expiré. */
  @Public()
  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  async logout(
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<void> {
    const access = request.cookies[AUTH_COOKIES.access];
    const claims = access ? await this.accessTokens.verify(access) : null;
    if (claims) {
      await this.sessions.revoke(claims.sid, 'LOGOUT');
      await this.audit.writeDirect(
        null,
        { action: 'auth.logout', resourceType: 'session', resourceId: claims.sid },
        await this.audit.principal(claims.realm, claims.sub),
      );
    } else {
      const refresh = request.cookies[AUTH_COOKIES.refresh];
      if (refresh) await this.sessions.revokeByRefreshToken(refresh, 'LOGOUT');
    }
    clearAuthCookies(reply, this.secure);
  }

  @AllowMfaSetup()
  @Get('me')
  me(@CurrentAuth() auth: AuthContext): Promise<MeResponse> {
    return this.auth.me(auth);
  }

  @Post('switch-company')
  @HttpCode(HttpStatus.NO_CONTENT)
  async switchCompany(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(switchCompanyRequestSchema)) body: { companyId: string },
  ): Promise<void> {
    await this.auth.switchCompany(auth, body.companyId);
  }

  @AllowMfaSetup()
  @Get('sessions')
  async listSessions(@CurrentAuth() auth: AuthContext): Promise<SessionSummary[]> {
    const rows = await this.sessions.listActive(auth.realm, auth.principalId);
    return rows.map((row) => ({
      id: row.id,
      current: row.id === auth.sessionId,
      ip: row.ip,
      userAgent: row.userAgent,
      createdAt: row.createdAt.toISOString(),
      lastUsedAt: row.lastUsedAt.toISOString(),
    }));
  }

  @AllowMfaSetup()
  @Audited({ action: 'auth.session_revoke', resourceType: 'session' })
  @Delete('sessions/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async revokeSession(
    @CurrentAuth() auth: AuthContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<void> {
    if (!(await this.sessions.revokeOwned(auth.realm, auth.principalId, id))) {
      throw new NotFoundException('Session introuvable');
    }
    if (id === auth.sessionId) clearAuthCookies(reply, this.secure);
  }

  @Audited({ action: 'auth.session_revoke_others', resourceType: 'session' })
  @Post('sessions/revoke-others')
  @HttpCode(HttpStatus.OK)
  async revokeOthers(@CurrentAuth() auth: AuthContext): Promise<{ revoked: number }> {
    const revoked = await this.sessions.revokeAll(
      auth.realm,
      auth.principalId,
      'OTHER_SESSIONS_REVOKED',
      auth.sessionId,
    );
    return { revoked };
  }

  @AllowMfaSetup()
  @Post('mfa/setup')
  @HttpCode(HttpStatus.OK)
  async setupMfa(@CurrentAuth() auth: AuthContext): Promise<MfaSetupResponse> {
    const [user] = await this.db
      .select({ email: users.email })
      .from(users)
      .where(and(eq(users.id, auth.principalId)));
    return this.mfa.startSetup('user', auth.principalId, user?.email ?? auth.principalId);
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

  @Audited({ action: 'auth.mfa_recovery_codes_regenerate', resourceType: 'mfa' })
  @Post('mfa/recovery-codes')
  @HttpCode(HttpStatus.OK)
  async regenerateRecoveryCodes(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(mfaConfirmRequestSchema)) body: { code: string },
  ): Promise<RecoveryCodesResponse> {
    return {
      recoveryCodes: await this.mfa.regenerateRecoveryCodes(
        auth.realm,
        auth.principalId,
        body.code,
      ),
    };
  }

  @Public()
  @Post('password/forgot')
  @HttpCode(HttpStatus.ACCEPTED)
  async forgotPassword(
    @Body(new ZodValidationPipe(forgotPasswordRequestSchema)) body: { email: string },
    @ReqMeta() meta: RequestMeta,
  ): Promise<void> {
    await this.auth.forgotPassword(body.email, meta);
  }

  @Public()
  @Post('password/reset')
  @HttpCode(HttpStatus.NO_CONTENT)
  async resetPassword(
    @Body(new ZodValidationPipe(resetPasswordRequestSchema))
    body: { token: string; password: string },
    @ReqMeta() meta: RequestMeta,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<void> {
    await this.auth.resetPassword(body.token, body.password, meta);
    clearAuthCookies(reply, this.secure);
  }

  @Public()
  @Get('invitations/preview')
  previewInvitation(
    @Query('token', new ZodValidationPipe(opaqueTokenSchema)) token: string,
    @ReqMeta() meta: RequestMeta,
  ): Promise<InvitationPreview> {
    return this.auth.previewInvitation(token, meta);
  }

  @Public()
  @Post('invitations/accept')
  @HttpCode(HttpStatus.CREATED)
  async acceptInvitation(
    @Body(new ZodValidationPipe(acceptInvitationRequestSchema)) body: AcceptInvitationRequest,
    @ReqMeta() meta: RequestMeta,
  ): Promise<void> {
    await this.auth.acceptInvitation(body, meta);
  }
}
