'use client';

import { Input, Label } from '@ecsi/ui';
import type { InputHTMLAttributes, ReactNode } from 'react';

export function Field({
  id,
  label,
  hint,
  ...input
}: { id: string; label: string; hint?: ReactNode } & InputHTMLAttributes<HTMLInputElement>) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} name={id} aria-describedby={hint ? `${id}-hint` : undefined} {...input} />
      {hint ? (
        <p id={`${id}-hint`} className="text-xs text-muted">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export function FormMessage({
  tone,
  children,
}: {
  tone: 'error' | 'success';
  children: ReactNode;
}) {
  return (
    <p
      role={tone === 'error' ? 'alert' : 'status'}
      className={
        tone === 'error'
          ? 'rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger'
          : 'rounded-md border border-success/30 bg-success/10 px-3 py-2 text-sm text-success'
      }
    >
      {children}
    </p>
  );
}

/** Valeur texte d'un champ de formulaire (chaîne vide si absent ou fichier). */
export function fieldValue(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value : '';
}
