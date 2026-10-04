import type { Router, RouterDetail } from '@ecsi/shared';
import { getTableColumns } from 'drizzle-orm';
import { routers } from '../database/schema/index.js';

/**
 * Colonnes lues par l'API pour une vue : TOUTES sauf le chiffré du mot de passe RouterOS,
 * qui ne quitte jamais la base par ce chemin (ni dans une réponse, ni dans un journal).
 */
const { routerosPasswordEncrypted: _never, ...viewColumns } = getTableColumns(routers);
export const ROUTER_VIEW_COLUMNS = viewColumns;

export type RouterViewRow = Omit<typeof routers.$inferSelect, 'routerosPasswordEncrypted'> & {
  /** Présence d'un mot de passe chiffré (jamais sa valeur). */
  hasPassword: boolean;
};

export interface SiteRef {
  id: string;
  name: string;
  code: string;
}

const iso = (value: Date | null) => (value ? value.toISOString() : null);

/** Adresse tunnel sans préfixe : PostgreSQL renvoie « 10.200.0.2 » pour un /32. */
export const hostOf = (inet: string) => inet.split('/')[0] ?? inet;

export function toRouter(row: RouterViewRow, site: SiteRef): Router {
  return {
    id: row.id,
    siteId: row.siteId,
    site,
    name: row.name,
    status: row.status,
    transport: row.transport,
    tunnelIp: hostOf(row.tunnelIp),
    wgPublicKey: row.wgPublicKey,
    hasCredentials: row.hasPassword && row.routerosUsername !== null,
    routerosUsername: row.routerosUsername,
    tlsFingerprint: row.tlsFingerprint,
    identity: row.identity,
    routerosVersion: row.routerosVersion,
    boardName: row.boardName,
    architecture: row.architecture,
    uptimeSeconds: row.uptimeSeconds,
    cpu: row.cpu,
    cpuCount: row.cpuCount,
    cpuLoad: row.cpuLoad,
    totalMemory: row.totalMemory,
    freeMemory: row.freeMemory,
    consecutiveFailures: row.consecutiveFailures,
    lastSeenAt: iso(row.lastSeenAt),
    lastSyncAt: iso(row.lastSyncAt),
    lastError: row.lastError,
    enrolledAt: iso(row.enrolledAt),
    activatedAt: iso(row.activatedAt),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toRouterDetail(
  row: RouterViewRow,
  site: SiteRef,
  enrollment: { expiresAt: Date; usedAt: Date | null } | null,
): RouterDetail {
  return {
    ...toRouter(row, site),
    interfaces: row.interfaces ?? [],
    enrollment: enrollment
      ? { expiresAt: enrollment.expiresAt.toISOString(), usedAt: iso(enrollment.usedAt) }
      : null,
  };
}
