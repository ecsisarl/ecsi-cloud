import type { RouterInterfaceSnapshot } from '../../database/schema/index.js';
import { RouterOsError } from '../routeros/errors.js';
import type { RouterOsRecord, RouterOsTransport } from '../routeros/transport.js';

/**
 * Données de supervision lues sur un routeur (Sprint 3A). Champs et menus repris de la sonde
 * de laboratoire lab/routeros/chr/probe.py (system/identity, system/resource, interface),
 * observés sur CHR RouterOS 7.24.5. Réservé pour la suite (non collecté) : trafic dans le
 * temps (interface/monitor-traffic), santé (system/health, absente sur CHR), pairs WireGuard.
 */
export interface RouterSnapshot {
  identity: string | null;
  routerosVersion: string | null;
  boardName: string | null;
  architecture: string | null;
  uptimeSeconds: number | null;
  cpu: string | null;
  cpuCount: number | null;
  cpuLoad: number | null;
  totalMemory: number | null;
  freeMemory: number | null;
  interfaces: RouterInterfaceSnapshot[];
}

export const INTERFACE_PROPLIST = [
  'name',
  'type',
  'running',
  'disabled',
  'mtu',
  'mac-address',
  'rx-byte',
  'tx-byte',
  'link-downs',
] as const;

const MAX_INTERFACES = 256;
const MAX_TEXT = 128;

export async function collectSnapshot(transport: RouterOsTransport): Promise<RouterSnapshot> {
  const [identity] = await transport.print('system/identity');
  const [resource] = await transport.print('system/resource');
  if (!resource) throw new RouterOsError('PROTOCOL', 'system/resource : réponse vide');
  const interfaces = await transport.print('interface', INTERFACE_PROPLIST);
  return {
    identity: text(identity?.name),
    routerosVersion: text(resource.version),
    boardName: text(resource['board-name']),
    architecture: text(resource['architecture-name']),
    uptimeSeconds: parseRouterOsDuration(resource.uptime),
    cpu: text(resource.cpu),
    cpuCount: integer(resource['cpu-count'], 0, 1024),
    cpuLoad: integer(resource['cpu-load'], 0, 100),
    totalMemory: integer(resource['total-memory'], 0, Number.MAX_SAFE_INTEGER),
    freeMemory: integer(resource['free-memory'], 0, Number.MAX_SAFE_INTEGER),
    interfaces: interfaces
      .slice(0, MAX_INTERFACES)
      .map((item) => toInterface(item))
      .filter((item): item is RouterInterfaceSnapshot => item !== null),
  };
}

function toInterface(item: RouterOsRecord): RouterInterfaceSnapshot | null {
  const name = text(item.name);
  if (!name) return null;
  return {
    name,
    type: text(item.type),
    running: bool(item.running),
    disabled: bool(item.disabled),
    mtu: integer(item.mtu, 0, 65535),
    macAddress: text(item['mac-address']),
    rxByte: integer(item['rx-byte'], 0, Number.MAX_SAFE_INTEGER),
    txByte: integer(item['tx-byte'], 0, Number.MAX_SAFE_INTEGER),
    linkDowns: integer(item['link-downs'], 0, Number.MAX_SAFE_INTEGER),
  };
}

function text(value: string | undefined): string | null {
  if (value === undefined) return null;
  const clean = value.replace(/\p{Cc}/gu, '').trim();
  return clean ? clean.slice(0, MAX_TEXT) : null;
}

function integer(value: string | undefined, min: number, max: number): number | null {
  if (value === undefined || !/^[0-9]{1,16}$/.test(value)) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= min && n <= max ? n : null;
}

function bool(value: string | undefined): boolean | null {
  if (value === 'true' || value === 'yes') return true;
  if (value === 'false' || value === 'no') return false;
  return null;
}

const UNITS: Record<string, number> = { w: 604_800, d: 86_400, h: 3_600, m: 60, s: 1 };

/**
 * Durée RouterOS -> secondes : « 1w2d3h4m5s » (forme observée sur RouterOS 7, millisecondes
 * éventuelles ignorées) ou « [Nd]hh:mm:ss ». Toute autre forme -> null (jamais devinée).
 */
export function parseRouterOsDuration(value: string | undefined): number | null {
  if (!value) return null;
  const units = /^(?:(\d+)w)?(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?(?:(\d+)ms)?$/.exec(value);
  if (units && value !== '') {
    const [, w, d, h, m, s] = units;
    const parts: [string | undefined, string][] = [
      [w, 'w'],
      [d, 'd'],
      [h, 'h'],
      [m, 'm'],
      [s, 's'],
    ];
    if (parts.every(([v]) => v === undefined) && units[6] === undefined) return null;
    return parts.reduce((total, [v, unit]) => total + (v ? Number(v) * (UNITS[unit] ?? 0) : 0), 0);
  }
  const clock = /^(?:(\d+)d)?(\d{1,2}):(\d{2}):(\d{2})$/.exec(value);
  if (clock) {
    const [, d, h, m, s] = clock;
    return Number(d ?? 0) * 86_400 + Number(h) * 3_600 + Number(m) * 60 + Number(s);
  }
  return null;
}
