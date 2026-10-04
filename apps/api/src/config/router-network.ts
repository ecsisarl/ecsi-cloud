import { z } from 'zod';
import { parseTunnelNetwork, TunnelIpError } from '../routers/tunnel-ip.js';

/**
 * Réseau tunnel WireGuard des routeurs (API : validation à l'enregistrement ; worker :
 * validation avant chaque connexion). Voir routers/tunnel-ip.ts.
 */
export const routerNetworkShape = {
  ROUTER_TUNNEL_CIDR: z.string().default('10.200.0.0/24'),
  ROUTER_TUNNEL_GATEWAY: z.string().default('10.200.0.1'),
};

export function refineRouterNetwork(
  value: { ROUTER_TUNNEL_CIDR: string; ROUTER_TUNNEL_GATEWAY: string },
  ctx: z.RefinementCtx,
): void {
  try {
    parseTunnelNetwork(value.ROUTER_TUNNEL_CIDR, value.ROUTER_TUNNEL_GATEWAY);
  } catch (error) {
    if (!(error instanceof TunnelIpError)) throw error;
    ctx.addIssue({ code: 'custom', path: ['ROUTER_TUNNEL_CIDR'], message: error.message });
  }
}
