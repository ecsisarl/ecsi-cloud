import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { Suspense } from 'react';
import { PageHeader } from '@/components/page-header';
import { BatchDetail } from '@/components/vouchers/batch-detail';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('nav'))('tickets') };
}

export default async function BatchPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const t = await getTranslations('tickets');
  return (
    <>
      <PageHeader title={t('title')} />
      <Suspense>
        <BatchDetail batchId={id} />
      </Suspense>
    </>
  );
}
