import { Logo } from '@ecsi/ui';
import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { PlatformShell } from '@/components/platform/platform-shell';
import { MfaSetup } from '@/components/security/mfa-setup';
import { getPlatformMe } from '@/lib/api';

export const dynamic = 'force-dynamic';

/**
 * Console des super administrateurs ECSI (domaine plateforme, séparé des entreprises).
 * Session plateforme obligatoire, 2FA configurée avant tout accès.
 */
export default async function PlatformLayout({ children }: { children: ReactNode }) {
  const session = await getPlatformMe();
  if (session.kind === 'unauthenticated') redirect('/plateforme/connexion');
  if (session.kind === 'forbidden') redirect('/');
  const { admin, mfa } = session.data;

  if (mfa.state === 'SETUP_REQUIRED') {
    return (
      <main className="mx-auto flex min-h-dvh w-full max-w-3xl flex-col gap-6 px-4 py-10">
        <Logo />
        <MfaSetup base="/platform/auth" enabled={false} required doneHref="/plateforme" />
      </main>
    );
  }
  return <PlatformShell adminName={admin.fullName}>{children}</PlatformShell>;
}
