import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { BatchPrint } from '@/components/vouchers/batch-print';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('nav'))('tickets') };
}

/** Feuille d'impression : la navigation du dashboard est masquée à l'impression. */
export default async function BatchPrintPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <BatchPrint batchId={id} />;
}
