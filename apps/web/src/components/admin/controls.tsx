'use client';

import type { ProblemDetails } from '@ecsi/shared';
import { cn, Label } from '@ecsi/ui';
import { useTranslations } from 'next-intl';
import {
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
  useCallback,
} from 'react';

const controlClasses =
  'w-full rounded-md border border-border bg-surface px-3 text-sm text-foreground ' +
  'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring ' +
  'disabled:cursor-not-allowed disabled:opacity-60';

export function Select({ className, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className={cn(controlClasses, 'h-10', className)} {...props} />;
}

export function Textarea({ className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={cn(controlClasses, 'min-h-20 py-2', className)} {...props} />;
}

/** Libellé + contrôle + aide, pour les contrôles autres que <Input> (select, textarea…). */
export function FieldShell({
  id,
  label,
  hint,
  children,
}: {
  id: string;
  label: string;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {hint ? <p className="text-xs text-muted">{hint}</p> : null}
    </div>
  );
}

/**
 * Message d'erreur lisible à partir d'une réponse de l'API (problem+json). Les messages
 * métier de l'API sont rédigés pour l'utilisateur ; les détails internes n'y figurent jamais.
 */
export function useProblemMessage() {
  const t = useTranslations('common');
  return useCallback(
    (status: number, problem: ProblemDetails | null): string => {
      if (status === 0) return t('errors.network');
      if (status === 403) return problem?.detail ?? t('errors.forbidden');
      if (status === 404) return t('errors.notFound');
      if (status === 422 && problem?.errors?.length) {
        return `${t('errors.invalid')} ${problem.errors.map((e) => e.message).join(' · ')}`;
      }
      if (status === 429) return t('errors.tooMany');
      if (status >= 500) return t('errors.server');
      return problem?.detail ?? problem?.title ?? t('errors.generic');
    },
    [t],
  );
}

/** Boîte de confirmation intégrée (pas de fenêtre native) pour les actions sensibles. */
export function ConfirmPanel({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3 rounded-md border border-warning/40 bg-warning-soft/40 p-4">
      <p className="text-sm font-semibold text-foreground">{title}</p>
      {description ? <p className="text-sm text-muted">{description}</p> : null}
      {children}
    </div>
  );
}

export function Toolbar({ children }: { children: ReactNode }) {
  return (
    <div className="mb-4 grid grid-cols-2 items-end gap-3 sm:flex sm:flex-row sm:flex-wrap">
      {children}
    </div>
  );
}

/** Tableau responsive : défilement horizontal sur petit écran plutôt qu'une mise en page cassée. */
export function DataTable({ children, testId }: { children: ReactNode; testId?: string }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-border bg-surface">
      <table className="w-full min-w-[640px] text-left text-sm" data-testid={testId}>
        {children}
      </table>
    </div>
  );
}

export function Th({ children, className }: { children?: ReactNode; className?: string }) {
  return (
    <th
      className={cn(
        'border-b border-border px-4 py-2.5 text-xs font-semibold text-muted uppercase',
        className,
      )}
    >
      {children}
    </th>
  );
}

export function Td({ children, className }: { children?: ReactNode; className?: string }) {
  return (
    <td className={cn('border-b border-border px-4 py-3 align-top', className)}>{children}</td>
  );
}

export function hasPermission(list: readonly string[], permission: string): boolean {
  return list.includes(permission);
}
