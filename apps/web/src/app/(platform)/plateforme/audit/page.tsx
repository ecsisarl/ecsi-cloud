import { getTranslations } from 'next-intl/server';
import { PageHeader } from '@/components/page-header';
import { PlatformAuditLog } from '@/components/platform/platform-audit-log';

export default async function PlatformAuditPage() {
  const t = await getTranslations('platformConsole');
  return (
    <>
      <PageHeader title={t('audit.title')} subtitle={t('audit.subtitle')} />
      <PlatformAuditLog />
    </>
  );
}
