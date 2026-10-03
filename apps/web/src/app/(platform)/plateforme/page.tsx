import { Card, CardContent, CardDescription, CardHeader, CardTitle, Logo } from '@ecsi/ui';
import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { MfaSetup } from '@/components/security/mfa-setup';
import { getPlatformMe } from '@/lib/api';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('platform'))('consoleTitle') };
}

/**
 * Console des super administrateurs ECSI (espace séparé des entreprises). Le Sprint 1 livre
 * la connexion et la 2FA obligatoire ; la gestion des entreprises arrive au Sprint 2.
 */
export default async function PlatformConsolePage() {
  const t = await getTranslations('platform');
  const session = await getPlatformMe();
  if (session.kind === 'unauthenticated') redirect('/plateforme/connexion');
  if (session.kind === 'forbidden') redirect('/');
  const { admin, mfa } = session.data;

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-3xl flex-col gap-6 px-4 py-10">
      <Logo />
      {mfa.state === 'SETUP_REQUIRED' ? (
        <MfaSetup base="/platform/auth" enabled={false} required doneHref="/plateforme" />
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>{t('consoleTitle')}</CardTitle>
            <CardDescription>{t('signedInAs', { name: admin.fullName })}</CardDescription>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted">{t('consoleSubtitle')}</p>
          </CardContent>
        </Card>
      )}
    </main>
  );
}
