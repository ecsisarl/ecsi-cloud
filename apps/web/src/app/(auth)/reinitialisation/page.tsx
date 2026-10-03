import type { Metadata } from 'next';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { AuthCard } from '@/components/auth/auth-card';
import { FormMessage } from '@/components/auth/form';
import { ResetPasswordForm } from '@/components/auth/reset-form';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('auth.reset'))('title'), referrer: 'no-referrer' };
}

export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const t = await getTranslations('auth');
  const { token } = await searchParams;
  const valid = typeof token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(token);
  return (
    <AuthCard title={t('reset.title')} subtitle={t('reset.subtitle')}>
      {valid ? (
        <ResetPasswordForm token={token} />
      ) : (
        <FormMessage tone="error">{t('reset.invalidLink')}</FormMessage>
      )}
      <Link href="/connexion" className="text-center text-sm text-primary hover:underline">
        {t('backToLogin')}
      </Link>
    </AuthCard>
  );
}
