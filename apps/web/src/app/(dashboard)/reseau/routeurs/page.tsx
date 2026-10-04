import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { PageHeader } from '@/components/page-header';
import { RoutersManager } from '@/components/routers/routers-manager';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('nav'))('routers') };
}

export default async function RoutersPage() {
  const t = await getTranslations('routers');
  return (
    <>
      <PageHeader title={t('title')} subtitle={t('subtitle')} />
      <RoutersManager />
    </>
  );
}
