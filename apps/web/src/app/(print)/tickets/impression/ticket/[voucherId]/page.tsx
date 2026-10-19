import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { VoucherPrint } from '@/components/hotspot/voucher-print';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('tickets.printSheet'))('pageTitle') };
}

export default async function VoucherPrintPage({
  params,
}: {
  params: Promise<{ voucherId: string }>;
}) {
  const { voucherId } = await params;
  if (!UUID.test(voucherId)) notFound();
  return <VoucherPrint kind="voucher" id={voucherId} />;
}
