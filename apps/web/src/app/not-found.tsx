import { buttonClasses } from '@ecsi/ui';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';

export default async function NotFound() {
  const t = await getTranslations('notFound');
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-4 p-6 text-center">
      <p className="text-5xl font-bold text-primary">404</p>
      <h1 className="text-xl font-semibold">{t('title')}</h1>
      <Link href="/" className={buttonClasses('secondary')}>
        {t('back')}
      </Link>
    </main>
  );
}
