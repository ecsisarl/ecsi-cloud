import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { HotspotsManager } from '@/components/hotspot/hotspots-manager';
import { PageHeader } from '@/components/page-header';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('nav'))('hotspots') };
}

export default async function HotspotsPage() {
  const t = await getTranslations('hotspots');
  return (
    <>
      <PageHeader title={t('title')} subtitle={t('subtitle')} />
      <HotspotsManager />
    </>
  );
}
