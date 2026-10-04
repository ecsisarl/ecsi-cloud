import { assertRouterTunnelIp, TunnelIpError, type TunnelNetwork } from '../tunnel-ip.js';
import { API_PORT, ApiTransport } from './api-transport.js';
import { RouterOsError } from './errors.js';
import { REST_PORT, RestTransport } from './rest-transport.js';
import {
  DEFAULT_TIMEOUTS,
  type RouterOsCredentials,
  type RouterOsTransport,
  type TransportTimeouts,
} from './transport.js';

export interface TransportTarget {
  readonly transport: 'REST_HTTPS' | 'API';
  readonly tunnelIp: string;
  readonly tlsFingerprint: string | null;
}

export type TransportFactory = (
  target: TransportTarget,
  credentials: RouterOsCredentials,
) => Promise<RouterOsTransport>;

/**
 * Seul point de création d'un transport en production : l'adresse est RE-VALIDÉE contre la
 * plage tunnel avant toute connexion (une valeur altérée en base ne mène nulle part ailleurs)
 * et le port est fixé par le code (443 ou 8728), jamais lu en base.
 */
export function tunnelTransportFactory(
  network: TunnelNetwork,
  timeouts: TransportTimeouts = DEFAULT_TIMEOUTS,
): TransportFactory {
  return async (target, credentials) => {
    let host: string;
    try {
      host = assertRouterTunnelIp(target.tunnelIp, network);
    } catch (error) {
      if (error instanceof TunnelIpError) throw new RouterOsError('CONFIG', error.message);
      throw error;
    }
    if (target.transport === 'API') {
      return ApiTransport.open({ host, port: API_PORT }, credentials, timeouts);
    }
    if (!target.tlsFingerprint) {
      throw new RouterOsError('TLS_PINNING', 'Empreinte TLS absente : REST refusé sans épinglage');
    }
    return new RestTransport(
      { host, port: REST_PORT },
      target.tlsFingerprint,
      credentials,
      timeouts,
    );
  };
}
