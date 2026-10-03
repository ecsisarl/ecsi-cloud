import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { PageHeader } from '@/components/page-header';
import { SiteGroupsManager } from '@/components/sites/site-groups-manager';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('nav'))('siteGroups') };
}

export default async function SiteGroupsPage() {
  const t = await getTranslations('siteGroups');
  return (
    <>
      <PageHeader title={t('title')} subtitle={t('subtitle')} />
      <SiteGroupsManager />
    </>
  );
}
