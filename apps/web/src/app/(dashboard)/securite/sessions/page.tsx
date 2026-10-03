import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { PageHeader } from '@/components/page-header';
import { SessionsManager } from '@/components/security/sessions-manager';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('security.sessions'))('title') };
}

export default async function SessionsPage() {
  const t = await getTranslations('security');
  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t('title')} />
      <div className="max-w-3xl">
        <SessionsManager />
      </div>
    </div>
  );
}
