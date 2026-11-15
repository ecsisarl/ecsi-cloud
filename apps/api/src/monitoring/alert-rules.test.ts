import type { AlertType } from '@ecsi/shared';
import { describe, expect, it } from 'vitest';
import {
  type AlertEvaluationInput,
  DEFAULT_ALERT_THRESHOLDS,
  evaluateAlerts,
  type MetricReading,
} from './alert-rules.js';

const reading = (cpuLoad: number | null, memoryUsedPercent: number | null = 40): MetricReading => ({
  cpuLoad,
  memoryUsedPercent,
});

const input = (overrides: Partial<AlertEvaluationInput> = {}): AlertEvaluationInput => ({
  status: 'ONLINE',
  consecutiveFailures: 0,
  lastError: null,
  recent: [reading(10)],
  open: new Set<AlertType>(),
  ...overrides,
});

const opened = (changes: ReturnType<typeof evaluateAlerts>) => changes.open.map((a) => a.type);

/**
 * Rejoue une suite de collectes en appliquant les changements à l'ensemble des alertes
 * ouvertes, comme le worker (MonitoringRecorder) : renvoie l'état après chaque collecte.
 */
function replay(steps: Partial<AlertEvaluationInput>[]): string[][] {
  const open = new Set<AlertType>();
  return steps.map((step) => {
    const changes = evaluateAlerts(input({ ...step, open: new Set(open) }));
    for (const alert of changes.open) open.add(alert.type);
    for (const type of changes.resolve) open.delete(type);
    return [...open].sort();
  });
}

describe('alertes de disponibilité', () => {
  it('routeur en ligne, mesures normales : aucune alerte', () => {
    expect(evaluateAlerts(input())).toEqual({ open: [], resolve: [] });
  });

  it('OFFLINE : alerte critique avec le nombre d’échecs et la dernière erreur', () => {
    const changes = evaluateAlerts(
      input({
        status: 'OFFLINE',
        consecutiveFailures: 4,
        lastError: 'UNREACHABLE: Délai dépassé',
        recent: [],
      }),
    );
    expect(changes.open).toEqual([
      {
        type: 'ROUTER_OFFLINE',
        severity: 'CRITICAL',
        details: { consecutiveFailures: 4, lastError: 'UNREACHABLE: Délai dépassé' },
      },
    ]);
    expect(changes.resolve).toEqual([]);
  });

  it('idempotent : une alerte déjà ouverte n’est jamais rouverte', () => {
    const changes = evaluateAlerts(
      input({
        status: 'OFFLINE',
        consecutiveFailures: 9,
        recent: [],
        open: new Set(['ROUTER_OFFLINE']),
      }),
    );
    expect(changes).toEqual({ open: [], resolve: [] });
  });

  it('retour en ligne : OFFLINE et DEGRADED résolues', () => {
    const changes = evaluateAlerts(input({ open: new Set(['ROUTER_OFFLINE', 'ROUTER_DEGRADED']) }));
    expect(changes.resolve.sort()).toEqual(['ROUTER_DEGRADED', 'ROUTER_OFFLINE']);
    expect(changes.open).toEqual([]);
  });

  it('DEGRADED : pas d’alerte sur un échec isolé, alerte à partir du seuil d’échecs', () => {
    expect(
      opened(evaluateAlerts(input({ status: 'DEGRADED', consecutiveFailures: 1, recent: [] }))),
    ).toEqual([]);
    expect(
      opened(evaluateAlerts(input({ status: 'DEGRADED', consecutiveFailures: 3, recent: [] }))),
    ).toEqual(['ROUTER_DEGRADED']);
  });

  it('DEGRADED puis OFFLINE : l’alerte OFFLINE remplace l’alerte DEGRADED', () => {
    const changes = evaluateAlerts(
      input({
        status: 'OFFLINE',
        consecutiveFailures: 4,
        recent: [],
        open: new Set(['ROUTER_DEGRADED']),
      }),
    );
    expect(opened(changes)).toEqual(['ROUTER_OFFLINE']);
    expect(changes.resolve).toEqual(['ROUTER_DEGRADED']);
  });

  it('tronque une dernière erreur trop longue', () => {
    const [alert] = evaluateAlerts(
      input({ status: 'OFFLINE', consecutiveFailures: 3, lastError: 'x'.repeat(500), recent: [] }),
    ).open;
    expect(String(alert?.details.lastError).length).toBe(200);
  });

  it('scénario complet de la supervision S3A : 3 DEGRADED, OFFLINE, puis retour', () => {
    expect(
      replay([
        { status: 'DEGRADED', consecutiveFailures: 1, recent: [] },
        { status: 'DEGRADED', consecutiveFailures: 2, recent: [] },
        { status: 'DEGRADED', consecutiveFailures: 3, recent: [] },
        { status: 'OFFLINE', consecutiveFailures: 4, recent: [] },
        { status: 'OFFLINE', consecutiveFailures: 5, recent: [] },
        { status: 'ONLINE', consecutiveFailures: 0, recent: [reading(5)] },
      ]),
    ).toEqual([[], [], ['ROUTER_DEGRADED'], ['ROUTER_OFFLINE'], ['ROUTER_OFFLINE'], []]);
  });
});

describe('alertes de charge (CPU, mémoire)', () => {
  const { cpuHighPercent, memoryHighPercent, hysteresisPercent, sustainSamples } =
    DEFAULT_ALERT_THRESHOLDS;

  it('pic isolé : aucune alerte ; dépassement soutenu : alerte avec la valeur et le seuil', () => {
    expect(
      opened(evaluateAlerts(input({ recent: [reading(99), reading(20), reading(20)] }))),
    ).toEqual([]);
    // Moins de mesures que la fenêtre (routeur tout juste ajouté) : pas encore d’alerte.
    expect(opened(evaluateAlerts(input({ recent: [reading(99), reading(99)] })))).toEqual([]);
    const changes = evaluateAlerts(
      input({ recent: Array.from({ length: sustainSamples }, () => reading(95)) }),
    );
    expect(changes.open).toEqual([
      {
        type: 'CPU_HIGH',
        severity: 'WARNING',
        details: { cpuLoad: 95, threshold: cpuHighPercent },
      },
    ]);
  });

  it('une mesure absente dans la fenêtre empêche l’ouverture', () => {
    expect(
      opened(evaluateAlerts(input({ recent: [reading(95), reading(null), reading(95)] }))),
    ).toEqual([]);
  });

  it('mémoire : même règle, sur le pourcentage utilisé', () => {
    const changes = evaluateAlerts(
      input({ recent: [reading(5, 97), reading(5, 95), reading(5, memoryHighPercent)] }),
    );
    expect(changes.open).toEqual([
      {
        type: 'MEMORY_HIGH',
        severity: 'WARNING',
        details: { memoryUsedPercent: 97, threshold: memoryHighPercent },
      },
    ]);
  });

  it('hystérésis : l’alerte reste ouverte juste sous le seuil, se résout plus bas', () => {
    const open = new Set<AlertType>(['CPU_HIGH']);
    expect(evaluateAlerts(input({ open, recent: [reading(cpuHighPercent - 1)] }))).toEqual({
      open: [],
      resolve: [],
    });
    expect(
      evaluateAlerts(input({ open, recent: [reading(cpuHighPercent - hysteresisPercent)] })),
    ).toEqual({ open: [], resolve: [] });
    expect(
      evaluateAlerts(input({ open, recent: [reading(cpuHighPercent - hysteresisPercent - 1)] }))
        .resolve,
    ).toEqual(['CPU_HIGH']);
  });

  it('collecte en échec (DEGRADED) : alerte de charge inchangée faute de mesure', () => {
    const open = new Set<AlertType>(['CPU_HIGH', 'MEMORY_HIGH']);
    expect(
      evaluateAlerts(input({ status: 'DEGRADED', consecutiveFailures: 1, recent: [], open })),
    ).toEqual({ open: [], resolve: [] });
  });

  it('hors ligne : les alertes de charge sont résolues, l’alerte OFFLINE les remplace', () => {
    const changes = evaluateAlerts(
      input({
        status: 'OFFLINE',
        consecutiveFailures: 3,
        recent: [],
        open: new Set(['CPU_HIGH', 'MEMORY_HIGH']),
      }),
    );
    expect(opened(changes)).toEqual(['ROUTER_OFFLINE']);
    expect(changes.resolve.sort()).toEqual(['CPU_HIGH', 'MEMORY_HIGH']);
  });

  it('seuils configurables', () => {
    const changes = evaluateAlerts(input({ recent: [reading(60)] }), {
      ...DEFAULT_ALERT_THRESHOLDS,
      cpuHighPercent: 50,
      sustainSamples: 1,
    });
    expect(opened(changes)).toEqual(['CPU_HIGH']);
  });
});
