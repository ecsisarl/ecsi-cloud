import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** Combine des classes Tailwind en résolvant les conflits (la dernière l'emporte). */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
