import type { ReactNode } from 'react';
import { cn } from '../cn';
import { Card } from './card';

export interface StatCardProps {
  label: string;
  /** Valeur déjà formatée (montant, nombre). `null` affiche un tiret : aucune donnée. */
  value: string | null;
  hint?: string;
  icon?: ReactNode;
  className?: string;
}

/** Indicateur clé du dashboard (CA du jour, tickets vendus, routeurs en ligne…). */
export function StatCard({ label, value, hint, icon, className }: StatCardProps) {
  return (
    <Card className={cn('p-5', className)}>
      <div className="flex items-start justify-between gap-3">
        <p className="text-sm font-medium text-muted">{label}</p>
        {icon ? <span className="text-primary">{icon}</span> : null}
      </div>
      <p className="mt-2 text-2xl font-semibold tracking-tight text-foreground tabular-nums">
        {value ?? '—'}
      </p>
      {hint ? <p className="mt-1 text-xs text-muted">{hint}</p> : null}
    </Card>
  );
}
