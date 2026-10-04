import { describe, expect, it } from 'vitest';
import { parseTunnelNetwork } from '../tunnel-ip.js';
import { GatewayPeerSync, type GatewayPeerRow } from './peer-sync.js';
import { parseAllowedIps, type WgClient, type WgPeer } from './wg-client.js';

const network = parseTunnelNetwork('10.200.0.0/24', '10.200.0.1');
const key = (c: string) => `${c.repeat(42)}A=`;
const CHR_LAB = key('L'); // configuré à la main au Sprint 3A, inconnu de app.gateway_peers()

function fakeWg(initial: WgPeer[]) {
  const peers = new Map(initial.map((p) => [p.publicKey, p.allowedIps]));
  const calls: string[] = [];
  const client: WgClient = {
    listPeers: () =>
      Promise.resolve([...peers].map(([publicKey, allowedIps]) => ({ publicKey, allowedIps }))),
    setPeer: (k, ip) => {
      calls.push(`set ${k.slice(0, 1)} ${ip}`);
      peers.set(k, [`${ip}/32`]);
      return Promise.resolve();
    },
    removePeer: (k) => {
      calls.push(`remove ${k.slice(0, 1)}`);
      peers.delete(k);
      return Promise.resolve();
    },
  };
  return { client, peers, calls };
}

const sync = (rows: GatewayPeerRow[], wg: WgClient) =>
  new GatewayPeerSync(() => Promise.resolve(rows), wg, network).run();

describe('synchronisation des pairs WireGuard', () => {
  it('ajoute les routeurs enrôlés, retire les supprimés, ne touche jamais un pair inconnu', async () => {
    const wg = fakeWg([
      { publicKey: CHR_LAB, allowedIps: ['10.200.0.2/32'] },
      { publicKey: key('D'), allowedIps: ['10.200.0.9/32'] },
    ]);
    const report = await sync(
      [
        { publicKey: key('N'), tunnelIp: '10.200.0.3', active: true },
        { publicKey: key('D'), tunnelIp: '10.200.0.9', active: false },
      ],
      wg.client,
    );
    expect(report).toEqual({ added: 1, updated: 0, removed: 1, refused: 0 });
    expect(wg.calls).toEqual(['set N 10.200.0.3', 'remove D']);
    expect(wg.peers.get(CHR_LAB)).toEqual(['10.200.0.2/32']);
    // Idempotent : un second passage ne change rien.
    wg.calls.length = 0;
    await sync([{ publicKey: key('N'), tunnelIp: '10.200.0.3', active: true }], wg.client);
    expect(wg.calls).toEqual([]);
  });

  it('corrige des adresses autorisées modifiées à la main', async () => {
    const wg = fakeWg([{ publicKey: key('N'), allowedIps: ['10.200.0.3/32', '0.0.0.0/0'] }]);
    const report = await sync(
      [{ publicKey: key('N'), tunnelIp: '10.200.0.3', active: true }],
      wg.client,
    );
    expect(report.updated).toBe(1);
    expect(wg.peers.get(key('N'))).toEqual(['10.200.0.3/32']);
  });

  it('refuse une adresse hors plage, la passerelle, ou une adresse tenue par un pair inconnu', async () => {
    const wg = fakeWg([{ publicKey: CHR_LAB, allowedIps: ['10.200.0.2/32'] }]);
    const report = await sync(
      [
        { publicKey: key('P'), tunnelIp: '8.8.8.8', active: true },
        { publicKey: key('G'), tunnelIp: '10.200.0.1', active: true },
        { publicKey: key('H'), tunnelIp: '10.200.0.2', active: true },
        { publicKey: 'invalide', tunnelIp: '10.200.0.4', active: true },
      ],
      wg.client,
    );
    expect(report).toEqual({ added: 0, updated: 0, removed: 0, refused: 4 });
    expect(wg.calls).toEqual([]);
    expect(wg.peers.get(CHR_LAB)).toEqual(['10.200.0.2/32']);
  });

  it('analyse la sortie de « wg show <if> allowed-ips »', () => {
    expect(
      parseAllowedIps(
        `${key('A')}\t10.200.0.2/32\n${key('B')}\t(none)\n${key('C')}\t10.200.0.5/32 10.9.0.0/16\n`,
      ),
    ).toEqual([
      { publicKey: key('A'), allowedIps: ['10.200.0.2/32'] },
      { publicKey: key('B'), allowedIps: [] },
      { publicKey: key('C'), allowedIps: ['10.200.0.5/32', '10.9.0.0/16'] },
    ]);
  });
});
