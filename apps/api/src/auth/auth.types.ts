import type { MfaState } from '@ecsi/shared';

/** Espace d'authentification : utilisateurs des entreprises ou super administrateurs ECSI. */
export type Realm = 'user' | 'platform';

/**
 * Contexte d'authentification d'une requête, construit UNIQUEMENT par AuthGuard à partir
 * du jeton d'accès vérifié et de la session lue en base. C'est la seule source du tenant
 * (companyId) : aucune valeur fournie par le client n'est utilisée pour le déterminer.
 */
export interface AuthContext {
  readonly realm: Realm;
  readonly sessionId: string;
  /** users.id (realm user) ou platform_admins.id (realm platform). */
  readonly principalId: string;
  readonly companyId: string | null;
  readonly mfaState: MfaState;
}

declare module 'fastify' {
  interface FastifyRequest {
    auth?: AuthContext;
  }
}

export interface RequestMeta {
  readonly ip: string;
  readonly userAgent: string | null;
}
