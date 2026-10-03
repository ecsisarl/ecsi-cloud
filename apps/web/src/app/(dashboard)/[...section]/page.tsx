import { EmptyState } from '@ecsi/ui';
import { Construction } from 'lucide-react';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { PageHeader } from '@/components/page-header';
import { findNavItem } from '@/lib/navigation';

/**
 * Page d'attente des modules non encore livrés. Elle annonce honnêtement le sprint
 * prévu au lieu d'afficher une interface factice. Chaque module la remplace par sa
 * propre page lors de sa livraison.
 */
export default async function PlannedModulePage({
  params,
}: {
  params: Promise<{ section: string[] }>;
}) {
  const { section } = await params;
  const item = findNavItem(`/${section.join('/')}`);
  if (!item?.plannedSprint) notFound();

  const tNav = await getTranslations('nav');
  const t = await getTranslations('placeholder');
  const later = item.plannedSprint.startsWith('V');
  // « S3 » est affiché « sprint 3 » ; « V1.1 » reste tel quel.
  const sprint = item.plannedSprint.replace(/^S/, '');

  return (
    <>
      <PageHeader title={tNav(item.key)} />
      <EmptyState
        icon={<Construction className="size-8" aria-hidden />}
        title={t('title')}
        description={later ? t('later', { sprint }) : t('description', { sprint })}
      />
    </>
  );
}
