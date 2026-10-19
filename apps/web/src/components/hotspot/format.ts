import type { HotspotSyncStatus, VoucherState } from '@ecsi/shared';
import type { BadgeTone } from '@ecsi/ui';

/**
 * Conversions de saisie et d'affichage des forfaits et tickets (lot B). Les unités affichées
 * sont celles d'un exploitant : minutes / heures / jours, Mo / Go, kbit/s / Mbit/s. L'API
 * reçoit toujours des secondes, des octets et des kbit/s.
 */
export const DURATION_UNITS = { MINUTES: 60, HOURS: 3_600, DAYS: 86_400 } as const;
export type DurationUnit = keyof typeof DURATION_UNITS;

/** 1 Mo = 1 048 576 octets (minimum de la base), 1 Go = 1 024 Mo. */
export const QUOTA_UNITS = { MB: 1_048_576, GB: 1_073_741_824 } as const;
export type QuotaUnit = keyof typeof QUOTA_UNITS;

/** 1 Mbit/s = 1 000 kbit/s. */
export const RATE_UNITS = { KBPS: 1, MBPS: 1_000 } as const;
export type RateUnit = keyof typeof RATE_UNITS;

/** Valeur saisie (texte) × unité -> entier, ou null si le champ est vide. NaN si invalide. */
export function fromParts<U extends string>(
  value: string,
  unit: U,
  units: Readonly<Record<U, number>>,
): number | null {
  const text = value.trim().replace(',', '.');
  if (text === '') return null;
  const amount = Number(text);
  if (!Number.isFinite(amount) || amount <= 0) return Number.NaN;
  return Math.round(amount * units[unit]);
}

/** Entier -> plus grande unité qui le divise exactement (pré-remplissage d'un formulaire). */
export function toParts<U extends string>(
  amount: number | null,
  units: Readonly<Record<U, number>>,
  fallback: U,
): { value: string; unit: U } {
  if (amount === null) return { value: '', unit: fallback };
  const ordered = (Object.entries(units) as [U, number][]).sort((a, b) => b[1] - a[1]);
  for (const [unit, size] of ordered) {
    if (amount % size === 0) return { value: String(amount / size), unit };
  }
  const smallest = ordered[ordered.length - 1];
  return smallest
    ? { value: String(amount / smallest[1]), unit: smallest[0] }
    : { value: String(amount), unit: fallback };
}

/** Durée lisible : « 2 j 3 h », « 1 h 30 min », « 45 min », « 30 s ». */
export function formatDuration(seconds: number | null): string {
  if (seconds === null) return '—';
  if (seconds < 60) return `${String(seconds)} s`;
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const parts: string[] = [];
  if (days > 0) parts.push(`${String(days)} j`);
  if (hours > 0) parts.push(`${String(hours)} h`);
  if (minutes > 0 && days === 0) parts.push(`${String(minutes)} min`);
  return parts.join(' ');
}

/** Volume lisible en Mo / Go (unités binaires, comme la saisie). */
export function formatVolume(bytes: number | null): string {
  if (bytes === null) return '—';
  if (bytes >= QUOTA_UNITS.GB) return `${trim(bytes / QUOTA_UNITS.GB)} Go`;
  if (bytes >= QUOTA_UNITS.MB) return `${trim(bytes / QUOTA_UNITS.MB)} Mo`;
  if (bytes >= 1024) return `${trim(bytes / 1024)} Ko`;
  return `${String(bytes)} o`;
}

/** Débit lisible : « 512 kbit/s », « 4 Mbit/s ». */
export function formatRate(kbps: number | null): string {
  if (kbps === null) return '—';
  return kbps >= 1_000 ? `${trim(kbps / 1_000)} Mbit/s` : `${String(kbps)} kbit/s`;
}

function trim(value: number): string {
  return (Math.round(value * 10) / 10).toLocaleString('fr-FR');
}

export const VOUCHER_STATE_TONE: Record<VoucherState, BadgeTone> = {
  AVAILABLE: 'primary',
  ACTIVE: 'success',
  EXHAUSTED: 'neutral',
  EXPIRED: 'warning',
  DISABLED: 'danger',
};

export const SYNC_STATUS_TONE: Record<HotspotSyncStatus, BadgeTone> = {
  PENDING: 'warning',
  APPLYING: 'primary',
  SYNCED: 'success',
  ERROR: 'danger',
};

/** Code découpé en deux groupes pour la lecture à voix haute (« abcd efgh »). */
export function groupCode(code: string): string {
  return code.length === 8 ? `${code.slice(0, 4)} ${code.slice(4)}` : code;
}
