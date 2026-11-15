import type { MetricPoint } from '@ecsi/shared';

export interface ChartFrame {
  /** Début et fin de la période affichée (ms). */
  from: number;
  to: number;
  width: number;
  height: number;
}

export const xOf = (at: number, frame: ChartFrame) =>
  frame.to === frame.from ? 0 : ((at - frame.from) / (frame.to - frame.from)) * frame.width;

/** Pourcentage (0 à 100) vers l'ordonnée SVG (0 en haut). */
export const yOf = (percent: number, frame: ChartFrame) =>
  frame.height - (Math.min(100, Math.max(0, percent)) / 100) * frame.height;

/**
 * Tracé SVG d'une série en pourcentage. Une valeur absente (collecte en échec) ou un trou de
 * plus de deux intervalles coupe la ligne : on ne relie jamais deux mesures par une valeur
 * inventée.
 */
export function seriesPath(
  points: readonly MetricPoint[],
  pick: (point: MetricPoint) => number | null,
  frame: ChartFrame,
  bucketMs: number,
): string {
  let path = '';
  let previous: number | null = null;
  for (const point of points) {
    const value = pick(point);
    const at = Date.parse(point.at);
    if (value === null) {
      previous = null;
      continue;
    }
    const command = previous === null || at - previous > 2 * bucketMs ? 'M' : 'L';
    path += `${command}${xOf(at, frame).toFixed(1)},${yOf(value, frame).toFixed(1)}`;
    previous = at;
  }
  return path;
}

/** Point le plus proche d'une abscisse (survol du graphique). */
export function nearestPoint(
  points: readonly MetricPoint[],
  x: number,
  frame: ChartFrame,
): MetricPoint | null {
  let best: MetricPoint | null = null;
  let distance = Infinity;
  for (const point of points) {
    const d = Math.abs(xOf(Date.parse(point.at), frame) - x);
    if (d < distance) {
      best = point;
      distance = d;
    }
  }
  return best;
}

/** Disponibilité sur la période (moyenne pondérée par le nombre de mesures), ou null. */
export function overallAvailability(points: readonly MetricPoint[]): number | null {
  let weighted = 0;
  let samples = 0;
  for (const point of points) {
    if (point.availability === null) continue;
    weighted += point.availability * point.samples;
    samples += point.samples;
  }
  return samples === 0 ? null : weighted / samples;
}
