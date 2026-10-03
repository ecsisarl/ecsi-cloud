import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { PageHeader } from '@/components/page-header';
import { MfaSetup } from '@/components/security/mfa-setup';
import { getMe } from '@/lib/api';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('security.mfa'))('title') };
}

export default async function MfaPage() {
  const t = await getTranslations('security');
  const session = await getMe();
  if (session.kind !== 'ok') redirect('/connexion');
  const { mfa } = session.data;
  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t('title')} />
      <div className="max-w-2xl">
        <MfaSetup base="/auth" enabled={mfa.enabled} required={mfa.required} doneHref="/" />
      </div>
    </div>
  );
}
