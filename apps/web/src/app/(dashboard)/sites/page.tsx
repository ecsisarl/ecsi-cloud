import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { PageHeader } from '@/components/page-header';
import { SitesManager } from '@/components/sites/sites-manager';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('nav'))('sites') };
}

export default async function SitesPage() {
  const t = await getTranslations('sites');
  return (
    <>
      <PageHeader title={t('title')} subtitle={t('subtitle')} />
      <SitesManager />
    </>
  );
}
