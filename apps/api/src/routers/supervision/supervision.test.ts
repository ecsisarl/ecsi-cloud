import { describe, expect, it } from 'vitest';
import { FAKE_INTERFACES, FAKE_RESOURCE } from '../../../test/helpers/fake-routeros.js';
import { RouterOsError, sanitizeDetail } from '../routeros/errors.js';
import type { RouterOsMenu, RouterOsRecord, RouterOsTransport } from '../routeros/transport.js';
import { collectSnapshot, parseRouterOsDuration } from './collector.js';
import { nextStatus } from './status.js';

function fakeTransport(data: Partial<Record<RouterOsMenu, RouterOsRecord[]>>): RouterOsTransport {
  return {
    kind: 'API',
    print: (menu) => Promise.resolve(data[menu] ?? []),
    close: () => Promise.resolve(),
  };
}

describe('collecte de supervision', () => {
  it('transforme les réponses RouterOS en instantané typé', async () => {
    const snapshot = await collectSnapshot(
      fakeTransport({
        'system/identity': [{ name: 'chr-ovh' }],
        'system/resource': [FAKE_RESOURCE],
        interface: FAKE_INTERFACES,
      }),
    );
    expect(snapshot).toMatchObject({
      identity: 'chr-ovh',
      routerosVersion: '7.23.7 (long-term)',
      boardName: 'CHR QEMU Standard PC (i440FX + PIIX, 1996)',
      architecture: 'x86_64',
      uptimeSeconds: 7 * 86400 + 2 * 86400 + 3 * 3600 + 4 * 60 + 5,
      cpu: 'QEMU',
      cpuCount: 2,
      cpuLoad: 7,
      totalMemory: 1073741824,
      freeMemory: 900000000,
    });
    expect(snapshot.interfaces[0]).toEqual({
      name: 'ether1',
      type: 'ether',
      running: true,
      disabled: false,
      mtu: 1500,
      macAddress: '0C:00:00:00:00:01',
      rxByte: 123456,
      txByte: 654321,
      linkDowns: 0,
    });
    expect(snapshot.interfaces[1]?.rxByte).toBeNull();
  });

  it('ignore les valeurs inattendues au lieu de les deviner', async () => {
    const snapshot = await collectSnapshot(
      fakeTransport({
        'system/identity': [{ name: 'x' }],
        'system/resource': [{ 'cpu-load': '250', 'cpu-count': 'deux', uptime: 'bientôt' }],
      }),
    );
    expect(snapshot.cpuLoad).toBeNull();
    expect(snapshot.cpuCount).toBeNull();
    expect(snapshot.uptimeSeconds).toBeNull();
  });

  it('system/resource vide : PROTOCOL', async () => {
    await expect(collectSnapshot(fakeTransport({}))).rejects.toMatchObject({ code: 'PROTOCOL' });
  });

  it.each([
    ['5s', 5],
    ['1m', 60],
    ['2h3m', 7380],
    ['1w', 604800],
    ['3d00:00:10', 259210],
    ['01:02:03', 3723],
    ['10s250ms', 10],
    ['', null],
    ['abc', null],
  ])('durée RouterOS « %s »', (value, expected) => {
    expect(parseRouterOsDuration(value)).toBe(expected);
  });
});

describe('états ONLINE / DEGRADED / OFFLINE', () => {
  const now = new Date('2026-10-04T12:00:00Z');
  const ago = (s: number) => new Date(now.getTime() - s * 1000);

  it('succès : ONLINE', () => {
    expect(
      nextStatus({
        previous: 'OFFLINE',
        outcome: 'success',
        consecutiveFailures: 0,
        lastContactAt: ago(999),
        now,
      }),
    ).toBe('ONLINE');
  });

  it('le routeur répond mais la collecte échoue : DEGRADED', () => {
    expect(
      nextStatus({
        previous: 'ONLINE',
        outcome: 'failure',
        consecutiveFailures: 10,
        lastContactAt: ago(9999),
        now,
      }),
    ).toBe('DEGRADED');
  });

  it('une erreur transitoire isolée ne rend jamais OFFLINE', () => {
    expect(
      nextStatus({
        previous: 'ONLINE',
        outcome: 'unreachable',
        consecutiveFailures: 1,
        lastContactAt: ago(60),
        now,
      }),
    ).toBe('DEGRADED');
    // Même après un long silence : il faut aussi plusieurs échecs consécutifs.
    expect(
      nextStatus({
        previous: 'ONLINE',
        outcome: 'unreachable',
        consecutiveFailures: 1,
        lastContactAt: ago(600),
        now,
      }),
    ).toBe('DEGRADED');
  });

  it('OFFLINE après le seuil de 180 s ET 3 échecs consécutifs', () => {
    expect(
      nextStatus({
        previous: 'DEGRADED',
        outcome: 'unreachable',
        consecutiveFailures: 3,
        lastContactAt: ago(179),
        now,
      }),
    ).toBe('DEGRADED');
    expect(
      nextStatus({
        previous: 'DEGRADED',
        outcome: 'unreachable',
        consecutiveFailures: 3,
        lastContactAt: ago(180),
        now,
      }),
    ).toBe('OFFLINE');
  });

  it('un routeur OFFLINE ou jamais joint reste OFFLINE tant qu’il ne répond pas', () => {
    expect(
      nextStatus({
        previous: 'OFFLINE',
        outcome: 'unreachable',
        consecutiveFailures: 1,
        lastContactAt: ago(5),
        now,
      }),
    ).toBe('OFFLINE');
  });

  it('seuils configurables', () => {
    expect(
      nextStatus(
        {
          previous: 'ONLINE',
          outcome: 'unreachable',
          consecutiveFailures: 2,
          lastContactAt: ago(40),
          now,
        },
        { offlineAfterSeconds: 30, offlineMinFailures: 2 },
      ),
    ).toBe('OFFLINE');
  });
});

describe('aucun secret dans les erreurs', () => {
  it('masque le mot de passe, en clair ou en base64, et borne la longueur', () => {
    const password = 'S3cret-RouterOS-Pass!';
    const text = sanitizeDetail(
      `echo ${password} Basic ${Buffer.from(password).toString('base64')}\n${'x'.repeat(500)}`,
      [password],
    );
    expect(text).not.toContain(password);
    expect(text).not.toContain(Buffer.from(password).toString('base64'));
    expect(text).toContain('[masqué]');
    expect(text.length).toBeLessThanOrEqual(161);
    expect(new RouterOsError('AUTH', 'x').unreachable).toBe(false);
    expect(new RouterOsError('UNREACHABLE', 'x').unreachable).toBe(true);
  });
});
