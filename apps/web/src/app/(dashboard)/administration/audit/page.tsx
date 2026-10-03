import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { CompanyAuditLog } from '@/components/admin/company-audit-log';
import { PageHeader } from '@/components/page-header';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('audit'))('title') };
}

export default async function Page() {
  const t = await getTranslations('audit');
  return (
    <>
      <PageHeader title={t('title')} subtitle={t('subtitle')} />
      <CompanyAuditLog />
    </>
  );
}
