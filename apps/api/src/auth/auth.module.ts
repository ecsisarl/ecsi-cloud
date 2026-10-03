import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { PermissionsGuard } from '../tenancy/permissions.guard.js';
import { AccessTokenService } from './access-token.service.js';
import { AuthController } from './auth.controller.js';
import { AuthGuard } from './auth.guard.js';
import { AuthService } from './auth.service.js';
import { MfaChallengeStore } from './mfa-challenge.store.js';
import { MfaService } from './mfa.service.js';
import { PlatformAuthController } from './platform-auth.controller.js';
import { RateLimiterService } from './rate-limiter.service.js';
import { secretBoxProvider } from './secret-box.provider.js';
import { SessionService } from './session.service.js';

@Module({
  controllers: [AuthController, PlatformAuthController],
  providers: [
    secretBoxProvider,
    AccessTokenService,
    SessionService,
    MfaService,
    MfaChallengeStore,
    RateLimiterService,
    AuthService,
    // Ordre d'exécution : authentification, puis permissions.
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
  ],
  exports: [AuthService, RateLimiterService, secretBoxProvider],
})
export class AuthModule {}
