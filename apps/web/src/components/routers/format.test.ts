import { describe, expect, it } from 'vitest';
import { formatBytes, formatMemory, formatUptime } from './format';

describe('affichage des données de supervision', () => {
  it('durée de fonctionnement', () => {
    expect(formatUptime(null)).toBe('—');
    expect(formatUptime(788_645)).toBe('9 j 3 h');
    expect(formatUptime(11_520)).toBe('3 h 12 min');
    expect(formatUptime(2_700)).toBe('45 min');
  });

  it('mémoire et volumes', () => {
    expect(formatMemory(null, 1)).toBe('—');
    expect(formatMemory(268_435_456, 134_217_728)).toBe('128 / 256 Mio (50 %)');
    expect(formatBytes(512)).toBe('512 o');
    expect(formatBytes(1_572_864)).toBe('1.5 Mio');
  });
});
