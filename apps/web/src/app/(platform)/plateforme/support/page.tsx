import { getTranslations } from 'next-intl/server';
import { PageHeader } from '@/components/page-header';
import { SupportConsole } from '@/components/platform/support-console';

export default async function PlatformSupportPage() {
  const t = await getTranslations('platformConsole');
  return (
    <>
      <PageHeader title={t('support.title')} subtitle={t('support.subtitle')} />
      <SupportConsole />
    </>
  );
}
