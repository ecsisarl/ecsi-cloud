'use client';

import type { MetricPoint, RouterMetrics } from '@ecsi/shared';
import { cn } from '@ecsi/ui';
import { useFormatter, useTranslations } from 'next-intl';
import { type MouseEvent, useCallback, useEffect, useState } from 'react';
import { FormMessage } from '@/components/auth/form';
import { useProblemMessage } from '@/components/admin/controls';
import { api } from '@/lib/client-api';
import { type ChartFrame, nearestPoint, overallAvailability, seriesPath, xOf, yOf } from './chart';

const RANGES = [1, 6, 24, 168] as const;
const WIDTH = 600;
const HEIGHT = 160;

function availabilityTone(value: number | null): string {
  if (value === null) return 'fill-surface-muted';
  if (value >= 1) return 'fill-success';
  return value > 0 ? 'fill-warning' : 'fill-danger';
}

/**
 * Historique d'un routeur (lot E1) : charge CPU et mémoire utilisée (moyennes par intervalle,
 * même échelle 0–100 %), et bande de disponibilité (part des collectes réussies). Les trous
 * (collectes en échec, absence de mesure) restent des trous.
 */
export function RouterHistory({
  routerId,
  refreshKey = 0,
}: {
  routerId: string;
  refreshKey?: number;
}) {
  const t = useTranslations('monitoring.history');
  const format = useFormatter();
  const problemMessage = useProblemMessage();
  const [hours, setHours] = useState<number>(24);
  const [metrics, setMetrics] = useState<RouterMetrics | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hover, setHover] = useState<MetricPoint | null>(null);
  /** Fin de la période affichée : l'heure de la réponse (pas l'heure du rendu). */
  const [loadedAt, setLoadedAt] = useState(0);

  const load = useCallback(async () => {
    const result = await api<RouterMetrics>(
      `/monitoring/routers/${routerId}/metrics?hours=${String(hours)}`,
    );
    if (result.ok) {
      setMetrics(result.data);
      setLoadedAt(Date.now());
      setError(null);
    } else setError(problemMessage(result.status, result.problem));
  }, [routerId, hours, problemMessage]);

  useEffect(() => {
    // Chargement de l'historique (et rechargement à chaque rafraîchissement de la page).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load, refreshKey]);

  const to = loadedAt;
  const frame: ChartFrame = {
    from: to - hours * 3_600_000,
    to,
    width: WIDTH,
    height: HEIGHT,
  };
  const points = metrics?.points ?? [];
  const bucketMs = (metrics?.bucketSeconds ?? 60) * 1000;
  const availability = overallAvailability(points);
  const percent = (value: number | null, digits = 0) =>
    value === null
      ? '—'
      : format.number(value / 100, { style: 'percent', maximumFractionDigits: digits });
  const time = (iso: string) =>
    format.dateTime(
      new Date(iso),
      hours > 24 ? { dateStyle: 'short', timeStyle: 'short' } : { timeStyle: 'short' },
    );

  function onMove(event: MouseEvent<SVGSVGElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    const x = ((event.clientX - rect.left) / rect.width) * WIDTH;
    setHover(nearestPoint(points, x, frame));
  }

  return (
    <div className="flex flex-col gap-3" data-testid="router-history">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-4 text-xs text-muted">
          <span className="flex items-center gap-1.5">
            <svg width="16" height="4" aria-hidden>
              <line x1="0" y1="2" x2="16" y2="2" className="stroke-chart-1" strokeWidth="2" />
            </svg>
            {t('cpu')}
          </span>
          <span className="flex items-center gap-1.5">
            <svg width="16" height="4" aria-hidden>
              <line
                x1="0"
                y1="2"
                x2="16"
                y2="2"
                className="stroke-chart-2"
                strokeWidth="2"
                strokeDasharray="4 2"
              />
            </svg>
            {t('memory')}
          </span>
          <span>
            {t('availability', {
              value: percent(availability === null ? null : availability * 100, 1),
            })}
          </span>
        </div>
        <div role="group" aria-label={t('range')} className="flex rounded-md border border-border">
          {RANGES.map((range) => (
            <button
              key={range}
              type="button"
              aria-pressed={hours === range}
              className={cn(
                'px-2.5 py-1 text-xs first:rounded-l-md last:rounded-r-md',
                hours === range
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted hover:bg-surface-muted',
              )}
              onClick={() => {
                setHours(range);
                setHover(null);
              }}
            >
              {t(`ranges.${String(range)}`)}
            </button>
          ))}
        </div>
      </div>

      {error ? <FormMessage tone="error">{error}</FormMessage> : null}

      {metrics && points.length === 0 ? (
        <p className="rounded-md border border-dashed border-border p-6 text-center text-sm text-muted">
          {t('empty')}
        </p>
      ) : null}

      {points.length > 0 ? (
        <div className="flex gap-2">
          <div className="flex h-40 flex-col justify-between py-0 text-right text-[10px] text-muted tabular-nums">
            <span>100 %</span>
            <span>50 %</span>
            <span>0 %</span>
          </div>
          <div className="relative min-w-0 flex-1">
            <svg
              viewBox={`0 0 ${String(WIDTH)} ${String(HEIGHT)}`}
              preserveAspectRatio="none"
              className="h-40 w-full overflow-visible"
              role="img"
              aria-label={t('chartLabel')}
              onMouseMove={onMove}
              onMouseLeave={() => {
                setHover(null);
              }}
            >
              {[0, 50, 100].map((level) => (
                <line
                  key={level}
                  x1="0"
                  x2={WIDTH}
                  y1={yOf(level, frame)}
                  y2={yOf(level, frame)}
                  className="stroke-border"
                  strokeWidth="1"
                  vectorEffect="non-scaling-stroke"
                />
              ))}
              <path
                d={seriesPath(points, (p) => p.memoryUsedPercent, frame, bucketMs)}
                className="fill-none stroke-chart-2"
                strokeWidth="2"
                strokeDasharray="6 3"
                strokeLinejoin="round"
                vectorEffect="non-scaling-stroke"
              />
              <path
                d={seriesPath(points, (p) => p.cpuLoad, frame, bucketMs)}
                className="fill-none stroke-chart-1"
                strokeWidth="2"
                strokeLinejoin="round"
                vectorEffect="non-scaling-stroke"
              />
              {hover ? (
                <line
                  x1={xOf(Date.parse(hover.at), frame)}
                  x2={xOf(Date.parse(hover.at), frame)}
                  y1="0"
                  y2={HEIGHT}
                  className="stroke-muted"
                  strokeWidth="1"
                  vectorEffect="non-scaling-stroke"
                />
              ) : null}
            </svg>
            <svg
              viewBox={`0 0 ${String(WIDTH)} 6`}
              preserveAspectRatio="none"
              className="mt-1 h-1.5 w-full"
              aria-hidden
            >
              {points.map((point) => {
                const x = xOf(Date.parse(point.at), frame);
                const w = Math.max(1, (bucketMs / (frame.to - frame.from)) * WIDTH - 0.5);
                return (
                  <rect
                    key={point.at}
                    x={x}
                    y="0"
                    width={w}
                    height="6"
                    rx="1"
                    className={availabilityTone(point.availability)}
                  />
                );
              })}
            </svg>
            <div className="mt-1 flex justify-between text-[10px] text-muted">
              <span>{time(new Date(frame.from).toISOString())}</span>
              <span>{t('now')}</span>
            </div>
            {hover ? (
              <div
                className="pointer-events-none absolute top-0 z-10 rounded-md border border-border bg-surface px-2.5 py-1.5 text-xs shadow-sm"
                style={{
                  left: `${String(Math.min(75, (xOf(Date.parse(hover.at), frame) / WIDTH) * 100))}%`,
                }}
              >
                <p className="font-medium text-foreground">{time(hover.at)}</p>
                <p className="text-muted">
                  {t('cpu')} : <span className="text-foreground">{percent(hover.cpuLoad)}</span>
                </p>
                <p className="text-muted">
                  {t('memory')} :{' '}
                  <span className="text-foreground">{percent(hover.memoryUsedPercent)}</span>
                </p>
                <p className="text-muted">
                  {t('availabilityShort')} :{' '}
                  <span className="text-foreground">
                    {percent(hover.availability === null ? null : hover.availability * 100)}
                  </span>
                </p>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}

      {points.length > 0 ? (
        <details className="text-sm">
          <summary className="cursor-pointer text-xs text-primary">{t('showValues')}</summary>
          <div className="mt-2 max-h-64 overflow-y-auto rounded-md border border-border">
            <table className="w-full text-left text-xs">
              <thead className="sticky top-0 bg-surface">
                <tr className="text-muted">
                  <th className="px-3 py-1.5 font-semibold">{t('time')}</th>
                  <th className="px-3 py-1.5 font-semibold">{t('cpu')}</th>
                  <th className="px-3 py-1.5 font-semibold">{t('memory')}</th>
                  <th className="px-3 py-1.5 font-semibold">{t('availabilityShort')}</th>
                </tr>
              </thead>
              <tbody className="tabular-nums">
                {[...points].reverse().map((point) => (
                  <tr key={point.at} className="border-t border-border">
                    <td className="px-3 py-1">{time(point.at)}</td>
                    <td className="px-3 py-1">{percent(point.cpuLoad)}</td>
                    <td className="px-3 py-1">{percent(point.memoryUsedPercent)}</td>
                    <td className="px-3 py-1">
                      {percent(point.availability === null ? null : point.availability * 100)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      ) : null}
    </div>
  );
}
