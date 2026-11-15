import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { VoucherPrint } from '@/components/hotspot/voucher-print';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('tickets.printSheet'))('pageTitle') };
}

export default async function BatchPrintPage({ params }: { params: Promise<{ batchId: string }> }) {
  const { batchId } = await params;
  if (!UUID.test(batchId)) notFound();
  return <VoucherPrint kind="batch" id={batchId} />;
}
