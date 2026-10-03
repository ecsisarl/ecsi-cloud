import { Card, CardContent, Logo } from '@ecsi/ui';
import type { ReactNode } from 'react';

/** Cadre commun des pages publiques d'authentification (mobile d'abord). */
export function AuthCard({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Card className="w-full max-w-md">
      <CardContent className="flex flex-col gap-6 p-6 sm:p-8">
        <div className="flex flex-col gap-2">
          <h1 className="text-xl font-semibold text-foreground">{title}</h1>
          {subtitle ? <p className="text-sm text-muted">{subtitle}</p> : null}
        </div>
        {children}
      </CardContent>
    </Card>
  );
}

export function AuthBrand({ tagline }: { tagline: string }) {
  return (
    <div className="flex flex-col items-center gap-2 text-center">
      <Logo />
      <p className="text-sm text-muted">{tagline}</p>
    </div>
  );
}
