import { describe, expect, it } from 'vitest';
import { assertRouterTunnelIp, parseIpv4, parseTunnelNetwork, TunnelIpError } from './tunnel-ip.js';

const lab = parseTunnelNetwork('10.200.0.0/24', '10.200.0.1');

describe('adresses tunnel des routeurs (anti-SSRF)', () => {
  it('accepte une adresse de la plage tunnel, avec ou sans /32', () => {
    expect(assertRouterTunnelIp('10.200.0.2', lab)).toBe('10.200.0.2');
    expect(assertRouterTunnelIp('10.200.0.254/32', lab)).toBe('10.200.0.254');
  });

  it.each([
    ['8.8.8.8', 'IP publique'],
    ['203.0.113.20', 'IP publique (documentation)'],
    ['127.0.0.1', 'boucle locale'],
    ['0.0.0.0', 'adresse non spécifiée'],
    ['169.254.169.254', 'métadonnées cloud (lien local)'],
    ['192.168.1.1', 'RFC 1918 hors plage (LAN)'],
    ['172.16.0.10', 'RFC 1918 hors plage'],
    ['10.0.0.5', 'RFC 1918 hors plage (réseau du cloud)'],
    ['10.200.1.2', 'plage voisine'],
    ['100.64.0.1', 'CGNAT hors plage'],
    ['10.200.0.1', 'passerelle'],
    ['10.200.0.0', 'adresse de réseau'],
    ['10.200.0.255', 'diffusion'],
    ['255.255.255.255', 'diffusion générale'],
  ])('refuse %s (%s)', (ip) => {
    expect(() => assertRouterTunnelIp(ip, lab)).toThrow(TunnelIpError);
  });

  it.each([
    '010.200.0.2', // zéro initial (octal pour certains analyseurs)
    '0x0a.200.0.2',
    '10.200.2',
    '167772162', // entier décimal
    '10.200.0.2:8080',
    'router.local',
    '10.200.0.2/24',
    '::ffff:10.200.0.2',
    '10.200.0.2 ',
    '',
  ])('refuse la forme non canonique « %s »', (ip) => {
    expect(() => assertRouterTunnelIp(ip, lab)).toThrow(TunnelIpError);
  });

  it('analyse strictement les IPv4', () => {
    expect(parseIpv4('10.200.0.2')).toBe(0x0ac80002);
    expect(parseIpv4('256.0.0.1')).toBeNull();
    expect(parseIpv4('01.2.3.4')).toBeNull();
  });
});

describe('configuration du réseau tunnel', () => {
  it('accepte une plage privée ou CGNAT, passerelle incluse', () => {
    expect(parseTunnelNetwork('100.100.0.0/16', '100.100.0.1').prefix).toBe(16);
    expect(parseTunnelNetwork('172.20.0.0/22', '172.20.0.1').prefix).toBe(22);
  });

  it.each([
    ['0.0.0.0/0', '0.0.0.1'],
    ['8.8.8.0/24', '8.8.8.1'],
    ['10.0.0.0/8', '10.0.0.1'], // trop large
    ['10.200.0.0/31', '10.200.0.1'], // trop étroite
    ['10.200.0.1/24', '10.200.0.2'], // pas une adresse de réseau
    ['127.0.0.0/24', '127.0.0.1'],
    ['169.254.0.0/16', '169.254.0.1'],
    ['10.200.0.0/24', '10.201.0.1'], // passerelle hors plage
    ['10.200.0.0/24', '10.200.0.255'],
    ['10.200.0.0', '10.200.0.1'],
  ])('refuse %s (passerelle %s)', (cidr, gw) => {
    expect(() => parseTunnelNetwork(cidr, gw)).toThrow(TunnelIpError);
  });
});
