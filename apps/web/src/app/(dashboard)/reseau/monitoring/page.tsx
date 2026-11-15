import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { PageHeader } from '@/components/page-header';
import { MonitoringDashboard } from '@/components/monitoring/monitoring-dashboard';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('nav'))('monitoring') };
}

export default async function MonitoringPage() {
  const t = await getTranslations('monitoring');
  return (
    <>
      <PageHeader title={t('title')} subtitle={t('subtitle')} />
      <MonitoringDashboard />
    </>
  );
}
