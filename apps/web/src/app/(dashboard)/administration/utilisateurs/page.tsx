import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { MembersManager } from '@/components/admin/members-manager';
import { PageHeader } from '@/components/page-header';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('members'))('title') };
}

export default async function Page() {
  const t = await getTranslations('members');
  return (
    <>
      <PageHeader title={t('title')} subtitle={t('subtitle')} />
      <MembersManager />
    </>
  );
}
