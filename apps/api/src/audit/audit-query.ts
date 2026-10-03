import type { AuditEvent, AuditPage, ListAuditQuery } from '@ecsi/shared';
import { and, desc, eq, gte, ilike, lt, lte, or, type SQL, sql } from 'drizzle-orm';
import type { Database } from '../database/database.module.js';
import { auditEvents, companies } from '../database/schema/index.js';
import type { TenantTransaction } from '../tenancy/tenant-database.js';

type Reader = Pick<Database, 'select'> | Pick<TenantTransaction, 'select'>;

/**
 * Lecture paginée du journal (curseur = dernier événement reçu, ordre antichronologique).
 * `companyId` : filtre obligatoire côté entreprise (en plus de la RLS), optionnel côté
 * plateforme. Les caractères spéciaux de LIKE dans la recherche sont échappés.
 */
export async function listAuditEvents(
  db: Reader,
  query: ListAuditQuery,
  companyId: string | null | undefined,
  options: { withCompanyName?: boolean } = {},
): Promise<AuditPage> {
  const filters: (SQL | undefined)[] = [
    companyId === undefined
      ? undefined
      : companyId === null
        ? sql`${auditEvents.companyId} is null`
        : eq(auditEvents.companyId, companyId),
    query.from ? gte(auditEvents.occurredAt, new Date(query.from)) : undefined,
    query.to ? lte(auditEvents.occurredAt, new Date(query.to)) : undefined,
    query.actorId ? eq(auditEvents.actorId, query.actorId) : undefined,
    query.action ? actionFilter(query.action) : undefined,
    query.resourceType ? eq(auditEvents.resourceType, query.resourceType) : undefined,
    query.resourceId ? eq(auditEvents.resourceId, query.resourceId) : undefined,
    query.siteId ? eq(auditEvents.siteId, query.siteId) : undefined,
    query.result ? eq(auditEvents.result, query.result) : undefined,
  ];
  if (query.q) {
    const pattern = `%${escapeLike(query.q)}%`;
    filters.push(
      or(
        ilike(auditEvents.actorLabel, pattern),
        ilike(auditEvents.action, pattern),
        ilike(auditEvents.resourceType, pattern),
        ilike(auditEvents.resourceId, pattern),
      ),
    );
  }
  if (query.cursor) {
    const [anchor] = await db
      .select({ occurredAt: auditEvents.occurredAt, id: auditEvents.id })
      .from(auditEvents)
      .where(eq(auditEvents.id, query.cursor));
    if (anchor) {
      filters.push(
        or(
          lt(auditEvents.occurredAt, anchor.occurredAt),
          and(eq(auditEvents.occurredAt, anchor.occurredAt), lt(auditEvents.id, anchor.id)),
        ),
      );
    }
  }

  const rows = await db
    .select({
      event: auditEvents,
      companyName: options.withCompanyName ? companies.name : sql<null>`null`,
    })
    .from(auditEvents)
    .leftJoin(
      companies,
      options.withCompanyName ? eq(companies.id, auditEvents.companyId) : sql`false`,
    )
    .where(and(...filters))
    .orderBy(desc(auditEvents.occurredAt), desc(auditEvents.id))
    .limit(query.limit + 1);

  const page = rows.slice(0, query.limit);
  return {
    data: page.map((row) => toView(row.event, row.companyName)),
    nextCursor: rows.length > query.limit ? (page.at(-1)?.event.id ?? null) : null,
  };
}

export async function getAuditEvent(
  db: Reader,
  id: string,
  companyId: string | undefined,
): Promise<AuditEvent | null> {
  const [row] = await db
    .select()
    .from(auditEvents)
    .where(
      and(eq(auditEvents.id, id), companyId ? eq(auditEvents.companyId, companyId) : undefined),
    );
  return row ? toView(row, null) : null;
}

/** « sites.* » filtre un préfixe, sinon égalité stricte. */
function actionFilter(action: string): SQL {
  return action.endsWith('.*')
    ? ilike(auditEvents.action, `${escapeLike(action.slice(0, -1))}%`)
    : eq(auditEvents.action, action);
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

function toView(row: typeof auditEvents.$inferSelect, companyName: string | null): AuditEvent {
  return {
    id: row.id,
    occurredAt: row.occurredAt.toISOString(),
    companyId: row.companyId,
    companyName,
    actorType: row.actorType as AuditEvent['actorType'],
    actorId: row.actorId,
    actorLabel: row.actorLabel,
    actorRoles: row.actorRoles,
    action: row.action,
    resourceType: row.resourceType,
    resourceId: row.resourceId,
    siteId: row.siteId,
    result: row.result as AuditEvent['result'],
    ip: row.ip,
    userAgent: row.userAgent,
    requestId: row.requestId,
    details: row.details,
    chainSeq: row.chainSeq,
  };
}
