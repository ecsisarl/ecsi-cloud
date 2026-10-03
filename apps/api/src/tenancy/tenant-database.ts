import { ForbiddenException, Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { AuthContext } from '../auth/auth.types.js';
import { DRIZZLE, type Database } from '../database/database.module.js';

export type TenantTransaction = Parameters<Parameters<Database['transaction']>[0]>[0];

/** Contexte tenant d'une requête : entreprise et utilisateur issus de la session authentifiée. */
export interface TenantContext {
  readonly companyId: string;
  readonly userId: string;
}

/**
 * Seul moyen d'obtenir un TenantContext : à partir du contexte construit par AuthGuard.
 * Un companyId présent dans l'URL, le corps ou un en-tête n'est JAMAIS utilisé.
 */
export function tenantContextOf(auth: AuthContext): TenantContext {
  if (auth.realm !== 'user' || !auth.companyId) {
    throw new ForbiddenException('Aucune entreprise active pour cette session');
  }
  return { companyId: auth.companyId, userId: auth.principalId };
}

/**
 * Accès aux données métier avec le rôle ecsi_app. Chaque appel ouvre une transaction et y
 * positionne app.company_id / app.user_id (SET LOCAL, portée transaction) : les politiques
 * Row-Level Security de PostgreSQL filtrent alors toute ligne d'une autre entreprise, même
 * si une requête oublie son filtre. Hors transaction, le contexte est vide : aucune ligne.
 */
@Injectable()
export class TenantDatabase {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  run<T>(context: TenantContext, work: (tx: TenantTransaction) => Promise<T>): Promise<T> {
    return this.db.transaction(async (tx) => {
      await tx.execute(
        sql`select set_config('app.company_id', ${context.companyId}, true), set_config('app.user_id', ${context.userId}, true)`,
      );
      return work(tx);
    });
  }
}
