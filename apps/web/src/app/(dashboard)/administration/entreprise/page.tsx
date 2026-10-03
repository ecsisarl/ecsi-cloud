import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { CompanySettings } from '@/components/admin/company-settings';
import { PageHeader } from '@/components/page-header';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('company'))('title') };
}

export default async function Page() {
  const t = await getTranslations('company');
  return (
    <>
      <PageHeader title={t('title')} subtitle={t('subtitle')} />
      <CompanySettings />
    </>
  );
}
