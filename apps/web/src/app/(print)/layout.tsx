import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { getMe } from '@/lib/api';

// Session obligatoire, jamais mis en cache ; les codes sont chargés par le navigateur
// (appel d'impression no-store), jamais rendus côté serveur ni placés dans l'URL.
export const dynamic = 'force-dynamic';

/** Pages d'impression (feuilles de tickets) : sans navigation, optimisées pour A4. */
export default async function PrintLayout({ children }: { children: ReactNode }) {
  const session = await getMe();
  if (session.kind === 'unauthenticated') redirect('/connexion');
  if (session.kind === 'forbidden') redirect('/plateforme');
  if (session.data.mfa.state === 'SETUP_REQUIRED') redirect('/securite/2fa');
  return <main className="min-h-dvh bg-background print:bg-white">{children}</main>;
}
