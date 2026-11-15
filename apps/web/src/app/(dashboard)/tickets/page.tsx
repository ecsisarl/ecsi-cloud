import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { PageHeader } from '@/components/page-header';
import { VouchersManager } from '@/components/vouchers/vouchers-manager';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('nav'))('tickets') };
}

export default async function TicketsPage() {
  const t = await getTranslations('tickets');
  return (
    <>
      <PageHeader title={t('title')} subtitle={t('subtitle')} />
      <VouchersManager />
    </>
  );
}
