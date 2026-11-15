import { describe, expect, it } from 'vitest';
import { ipBucket } from './rate-limiter.service.js';

describe('ipBucket', () => {
  it('garde une adresse IPv4 telle quelle (y compris IPv4 dans IPv6)', () => {
    expect(ipBucket('203.0.113.7')).toBe('203.0.113.7');
    expect(ipBucket('::ffff:203.0.113.7')).toBe('203.0.113.7');
  });

  it('regroupe une adresse IPv6 par réseau /64, quelle que soit son écriture', () => {
    const bucket = '2001:db8:a:b::/64';
    expect(ipBucket('2001:db8:a:b::1')).toBe(bucket);
    expect(ipBucket('2001:0DB8:000a:000b:1234:5678:9abc:def0')).toBe(bucket);
    expect(ipBucket('2001:db8:a:b:ffff::')).toBe(bucket);
    expect(ipBucket('2001:db8:a:c::1')).not.toBe(bucket);
  });

  it('gère les formes abrégées en tête et l’identifiant de zone', () => {
    expect(ipBucket('::1')).toBe('0:0:0:0::/64');
    expect(ipBucket('fe80::1%eth0')).toBe('fe80:0:0:0::/64');
    expect(ipBucket('2001:db8::')).toBe('2001:db8:0:0::/64');
  });
});
