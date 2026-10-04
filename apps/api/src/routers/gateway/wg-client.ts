import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { WIREGUARD_PUBLIC_KEY } from '@ecsi/shared';

const run = promisify(execFile);

export interface WgPeer {
  publicKey: string;
  /** Adresses autorisées (« a.b.c.d/nn »), vide si aucune. */
  allowedIps: string[];
}

/** Opérations WireGuard de l'agent passerelle : pairs uniquement, jamais la clé privée. */
export interface WgClient {
  listPeers(): Promise<WgPeer[]>;
  /** Déclare (ou met à jour) un pair avec UNE adresse /32. */
  setPeer(publicKey: string, tunnelIp: string): Promise<void>;
  removePeer(publicKey: string): Promise<void>;
}

const IPV4_32 =
  /^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])$/;

/** Analyse la sortie de « wg show <interface> allowed-ips » (clé, tabulation, adresses). */
export function parseAllowedIps(output: string): WgPeer[] {
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [publicKey = '', ips = ''] = line.split('\t');
      return {
        publicKey,
        allowedIps: ips === '(none)' ? [] : ips.split(' ').filter(Boolean),
      };
    })
    .filter((peer) => WIREGUARD_PUBLIC_KEY.test(peer.publicKey));
}

/**
 * Client wg(8) par execFile (aucun shell : pas d'interprétation des arguments). Commandes
 * documentées de wg(8) : « wg show <if> allowed-ips », « wg set <if> peer <clé> allowed-ips
 * <ip>/32 », « wg set <if> peer <clé> remove ». Les valeurs sont revalidées ici.
 */
export function execWgClient(command: string, iface: string, timeoutMs = 5_000): WgClient {
  const wg = async (...args: string[]) =>
    (await run(command, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 })).stdout;
  const key = (value: string) => {
    if (!WIREGUARD_PUBLIC_KEY.test(value)) throw new Error('Clé publique WireGuard invalide');
    return value;
  };
  return {
    async listPeers() {
      return parseAllowedIps(await wg('show', iface, 'allowed-ips'));
    },
    async setPeer(publicKey, tunnelIp) {
      if (!IPV4_32.test(tunnelIp)) throw new Error('Adresse tunnel invalide');
      await wg('set', iface, 'peer', key(publicKey), 'allowed-ips', `${tunnelIp}/32`);
    },
    async removePeer(publicKey) {
      await wg('set', iface, 'peer', key(publicKey), 'remove');
    },
  };
}
