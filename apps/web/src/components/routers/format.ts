import type { Router } from '@ecsi/shared';
import type { BadgeTone } from '@ecsi/ui';

export const ROUTER_STATUS_TONE: Record<Router['status'], BadgeTone> = {
  PROVISIONING: 'primary',
  ONLINE: 'success',
  DEGRADED: 'warning',
  OFFLINE: 'danger',
};

/** Durée de fonctionnement lisible : « 9 j 3 h », « 3 h 12 min », « 45 min ». */
export function formatUptime(seconds: number | null): string {
  if (seconds === null) return '—';
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  if (days > 0) return `${String(days)} j ${String(hours)} h`;
  if (hours > 0) return `${String(hours)} h ${String(minutes)} min`;
  return `${String(minutes)} min`;
}

/** Mémoire : utilisée / totale en Mio. */
export function formatMemory(total: number | null, free: number | null): string {
  if (total === null || free === null || total <= 0) return '—';
  const mib = (bytes: number) => Math.round(bytes / 1_048_576);
  const used = total - free;
  return `${String(mib(used))} / ${String(mib(total))} Mio (${String(Math.round((used / total) * 100))} %)`;
}

export function formatBytes(value: number | null): string {
  if (value === null) return '—';
  const units = ['o', 'Kio', 'Mio', 'Gio', 'Tio'];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size.toFixed(unit === 0 ? 0 : 1)} ${units[unit] ?? ''}`;
}
