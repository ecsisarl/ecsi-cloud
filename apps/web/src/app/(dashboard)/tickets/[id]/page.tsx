import { notFound } from 'next/navigation';
import { VoucherDetail } from '@/components/hotspot/voucher-detail';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function VoucherPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  return <VoucherDetail id={id} />;
}
