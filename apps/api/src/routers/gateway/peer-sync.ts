import { WIREGUARD_PUBLIC_KEY } from '@ecsi/shared';
import { assertRouterTunnelIp, type TunnelNetwork } from '../tunnel-ip.js';
import type { WgClient } from './wg-client.js';

/** Ligne de app.gateway_peers() (migration 0006). */
export interface GatewayPeerRow {
  publicKey: string;
  tunnelIp: string;
  active: boolean;
}

export interface PeerSyncReport {
  added: number;
  updated: number;
  removed: number;
  /** Pairs refusés (adresse invalide, ou déjà tenue par un pair inconnu de la base). */
  refused: number;
}

export interface PeerSyncLogger {
  warn(message: string): void;
}

/**
 * Synchronisation des pairs WireGuard de la passerelle avec la base :
 *  - routeur enrôlé et actif : pair déclaré avec SON adresse tunnel en /32 (et rien d'autre :
 *    la passerelle n'accepte de ce pair que les paquets de cette adresse) ;
 *  - routeur supprimé : son pair est retiré ;
 *  - pair INCONNU de la base (ex. CHR-LAB configuré à la main au Sprint 3A) : jamais touché.
 *    Une adresse déjà tenue par un pair inconnu n'est pas réattribuée (WireGuard la lui
 *    retirerait silencieusement) : refus journalisé.
 */
export class GatewayPeerSync {
  constructor(
    private readonly loadPeers: () => Promise<GatewayPeerRow[]>,
    private readonly wg: WgClient,
    private readonly network: TunnelNetwork,
    private readonly logger: PeerSyncLogger = { warn: () => undefined },
  ) {}

  async run(): Promise<PeerSyncReport> {
    const report: PeerSyncReport = { added: 0, updated: 0, removed: 0, refused: 0 };
    const rows = await this.loadPeers();
    const current = new Map((await this.wg.listPeers()).map((p) => [p.publicKey, p.allowedIps]));
    const known = new Set(rows.map((row) => row.publicKey));
    const heldByUnknown = new Set<string>();
    for (const [key, ips] of current) {
      if (!known.has(key)) for (const ip of ips) heldByUnknown.add(ip.split('/')[0] ?? ip);
    }

    const active = new Map<string, string>();
    for (const row of rows) {
      if (!row.active) continue;
      if (!WIREGUARD_PUBLIC_KEY.test(row.publicKey)) {
        report.refused += 1;
        continue;
      }
      let ip: string;
      try {
        ip = assertRouterTunnelIp(row.tunnelIp.split('/')[0] ?? '', this.network);
      } catch {
        this.logger.warn(`Pair ignoré : adresse tunnel hors plage (${row.tunnelIp})`);
        report.refused += 1;
        continue;
      }
      if (heldByUnknown.has(ip)) {
        this.logger.warn(`Pair ignoré : ${ip} est déjà tenue par un pair inconnu de la base`);
        report.refused += 1;
        continue;
      }
      active.set(row.publicKey, ip);
    }

    for (const [key, ip] of active) {
      const ips = current.get(key);
      if (ips === undefined) {
        await this.wg.setPeer(key, ip);
        report.added += 1;
      } else if (ips.length !== 1 || ips[0] !== `${ip}/32`) {
        await this.wg.setPeer(key, ip);
        report.updated += 1;
      }
    }
    for (const row of rows) {
      if (row.active || active.has(row.publicKey) || !current.has(row.publicKey)) continue;
      await this.wg.removePeer(row.publicKey);
      current.delete(row.publicKey);
      report.removed += 1;
    }
    return report;
  }
}
