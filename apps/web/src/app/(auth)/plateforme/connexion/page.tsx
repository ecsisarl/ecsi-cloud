import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { AuthCard } from '@/components/auth/auth-card';
import { LoginFlow } from '@/components/auth/login-flow';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('platform'))('loginTitle') };
}

export default async function PlatformLoginPage() {
  const t = await getTranslations('platform');
  return (
    <AuthCard title={t('loginTitle')} subtitle={t('loginSubtitle')}>
      <LoginFlow realm="platform" />
    </AuthCard>
  );
}
