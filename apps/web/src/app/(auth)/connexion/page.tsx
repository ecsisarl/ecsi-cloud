import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { AuthCard } from '@/components/auth/auth-card';
import { LoginFlow } from '@/components/auth/login-flow';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('auth.login'))('title') };
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const t = await getTranslations('auth.login');
  const { next } = await searchParams;
  return (
    <AuthCard title={t('title')} subtitle={t('subtitle')}>
      <LoginFlow realm="user" next={next} />
    </AuthCard>
  );
}
