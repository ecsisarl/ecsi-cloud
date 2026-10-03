import { cn } from '../cn';

export interface LogoProps {
  className?: string;
  /** Affiche uniquement le symbole, sans le nom (barre latérale réduite, favicon). */
  symbolOnly?: boolean;
}

/** Logo ECSI CLOUD : un nuage stylisé portant des ondes WiFi. */
export function Logo({ className, symbolOnly = false }: LogoProps) {
  return (
    <span className={cn('inline-flex items-center gap-2', className)}>
      <svg viewBox="0 0 32 32" aria-hidden className="size-8 shrink-0">
        <rect width="32" height="32" rx="8" fill="#1d4ed8" />
        <path
          d="M10 21.5h12.2a4.3 4.3 0 0 0 .6-8.56A6 6 0 0 0 11.3 14 3.75 3.75 0 0 0 10 21.5Z"
          fill="#fff"
          opacity=".95"
        />
        <path
          d="M13.4 17.6a3.7 3.7 0 0 1 5.2 0"
          stroke="#1d4ed8"
          strokeWidth="1.6"
          fill="none"
          strokeLinecap="round"
        />
        <circle cx="16" cy="19.4" r="1.1" fill="#1d4ed8" />
      </svg>
      {symbolOnly ? null : (
        <span className="text-base font-bold tracking-tight">
          ECSI <span className="font-medium opacity-80">CLOUD</span>
        </span>
      )}
    </span>
  );
}
