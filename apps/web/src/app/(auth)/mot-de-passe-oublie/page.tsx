import type { Metadata } from 'next';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { AuthCard } from '@/components/auth/auth-card';
import { ForgotPasswordForm } from '@/components/auth/forgot-form';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('auth.forgotPage'))('title') };
}

export default async function ForgotPasswordPage() {
  const t = await getTranslations('auth');
  return (
    <AuthCard title={t('forgotPage.title')} subtitle={t('forgotPage.subtitle')}>
      <ForgotPasswordForm />
      <Link href="/connexion" className="text-center text-sm text-primary hover:underline">
        {t('backToLogin')}
      </Link>
    </AuthCard>
  );
}
