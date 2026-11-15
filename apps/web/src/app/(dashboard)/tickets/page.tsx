import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { TicketsManager } from '@/components/hotspot/tickets-manager';
import { PageHeader } from '@/components/page-header';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('nav'))('tickets') };
}

export default async function TicketsPage() {
  const t = await getTranslations('tickets');
  return (
    <>
      <PageHeader title={t('title')} subtitle={t('subtitle')} />
      <TicketsManager />
    </>
  );
}
