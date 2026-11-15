import { describe, expect, it } from 'vitest';
import {
  DURATION_UNITS,
  formatDuration,
  formatRate,
  formatVolume,
  fromParts,
  groupCode,
  QUOTA_UNITS,
  RATE_UNITS,
  toParts,
} from './format';

describe('saisie des forfaits', () => {
  it('convertit valeur et unité', () => {
    expect(fromParts('1', 'HOURS', DURATION_UNITS)).toBe(3600);
    expect(fromParts('1,5', 'HOURS', DURATION_UNITS)).toBe(5400);
    expect(fromParts('', 'DAYS', DURATION_UNITS)).toBeNull();
    expect(fromParts('500', 'MB', QUOTA_UNITS)).toBe(524_288_000);
    expect(fromParts('2', 'GB', QUOTA_UNITS)).toBe(2_147_483_648);
    expect(fromParts('4', 'MBPS', RATE_UNITS)).toBe(4000);
    expect(fromParts('abc', 'MINUTES', DURATION_UNITS)).toBeNaN();
    expect(fromParts('-1', 'MINUTES', DURATION_UNITS)).toBeNaN();
  });

  it('pré-remplit avec la plus grande unité exacte', () => {
    expect(toParts(86_400, DURATION_UNITS, 'HOURS')).toEqual({ value: '1', unit: 'DAYS' });
    expect(toParts(5400, DURATION_UNITS, 'HOURS')).toEqual({ value: '90', unit: 'MINUTES' });
    expect(toParts(null, DURATION_UNITS, 'HOURS')).toEqual({ value: '', unit: 'HOURS' });
    expect(toParts(1_073_741_824, QUOTA_UNITS, 'MB')).toEqual({ value: '1', unit: 'GB' });
    expect(toParts(1500, RATE_UNITS, 'KBPS')).toEqual({ value: '1500', unit: 'KBPS' });
  });
});

describe('affichage', () => {
  it('durées, volumes et débits', () => {
    expect(formatDuration(3600)).toBe('1 h');
    expect(formatDuration(5400)).toBe('1 h 30 min');
    expect(formatDuration(90_000)).toBe('1 j 1 h');
    expect(formatDuration(45)).toBe('45 s');
    expect(formatDuration(null)).toBe('—');
    expect(formatVolume(524_288_000)).toBe('500 Mo');
    expect(formatVolume(1_610_612_736)).toBe('1,5 Go');
    expect(formatRate(512)).toBe('512 kbit/s');
    expect(formatRate(4000)).toBe('4 Mbit/s');
  });

  it('code lisible en deux groupes', () => {
    expect(groupCode('abcd2345')).toBe('abcd 2345');
  });
});
