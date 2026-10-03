import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { PageHeader } from '@/components/page-header';
import { CompaniesConsole } from '@/components/platform/companies-console';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('platform'))('consoleTitle') };
}

export default async function PlatformConsolePage() {
  const t = await getTranslations('platformConsole');
  return (
    <>
      <PageHeader title={t('companies.title')} subtitle={t('companies.subtitle')} />
      <CompaniesConsole />
    </>
  );
}
