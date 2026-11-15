import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { PageHeader } from '@/components/page-header';
import { PlansManager } from '@/components/plans/plans-manager';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('nav'))('plans') };
}

export default async function PlansPage() {
  const t = await getTranslations('plans');
  return (
    <>
      <PageHeader title={t('title')} subtitle={t('subtitle')} />
      <PlansManager />
    </>
  );
}
