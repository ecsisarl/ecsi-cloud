import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { AppShell } from '@/components/app-shell';
import { getMe } from '@/lib/api';

// Chaque page du dashboard dépend de la session : jamais mise en cache.
export const dynamic = 'force-dynamic';

const MFA_SETUP_PATH = '/securite/2fa';

export default async function DashboardLayout({ children }: { children: ReactNode }) {
  const session = await getMe();
  if (session.kind === 'unauthenticated') redirect('/connexion');
  // Session super administrateur : console plateforme, jamais le dashboard d'une entreprise.
  if (session.kind === 'forbidden') redirect('/plateforme');

  const pathname = (await headers()).get('x-ecsi-pathname') ?? '/';
  if (session.data.mfa.state === 'SETUP_REQUIRED' && pathname !== MFA_SETUP_PATH) {
    redirect(MFA_SETUP_PATH);
  }
  return <AppShell me={session.data}>{children}</AppShell>;
}
