import type { MetricPoint } from '@ecsi/shared';
import { describe, expect, it } from 'vitest';
import { nearestPoint, overallAvailability, seriesPath, type ChartFrame } from './chart';

const at = (minute: number) => new Date(Date.UTC(2026, 9, 18, 12, minute)).toISOString();
const point = (minute: number, cpuLoad: number | null, availability = 1, samples = 1) =>
  ({ at: at(minute), cpuLoad, memoryUsedPercent: null, availability, samples }) as MetricPoint;
const frame: ChartFrame = {
  from: Date.parse(at(0)),
  to: Date.parse(at(10)),
  width: 100,
  height: 50,
};

describe('graphique de supervision', () => {
  it('trace les mesures en pourcentage (0 en bas, 100 en haut)', () => {
    expect(seriesPath([point(0, 0), point(10, 100)], (p) => p.cpuLoad, frame, 600_000)).toBe(
      'M0.0,50.0L100.0,0.0',
    );
  });

  it('coupe la ligne sur une mesure absente ou un trou, sans inventer de valeur', () => {
    const path = seriesPath(
      [point(0, 10), point(1, null), point(2, 20), point(3, 30), point(9, 40)],
      (p) => p.cpuLoad,
      frame,
      60_000,
    );
    expect(path.match(/M/g)).toHaveLength(3);
    expect(path.match(/L/g)).toHaveLength(1);
  });

  it('point le plus proche et disponibilité pondérée', () => {
    expect(nearestPoint([point(0, 1), point(5, 2), point(10, 3)], 60, frame)?.cpuLoad).toBe(2);
    expect(nearestPoint([], 10, frame)).toBeNull();
    expect(overallAvailability([point(0, 1, 1, 3), point(1, 1, 0, 1)])).toBe(0.75);
    expect(overallAvailability([])).toBeNull();
  });
});
