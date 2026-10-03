import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { AuthCard } from '@/components/auth/auth-card';
import { FormMessage } from '@/components/auth/form';
import { InvitationForm } from '@/components/auth/invitation-form';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('auth.invitation'))('title'), referrer: 'no-referrer' };
}

export default async function InvitationPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const t = await getTranslations('auth.invitation');
  const { token } = await searchParams;
  const valid = typeof token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(token);
  return (
    <AuthCard title={t('title')}>
      {valid ? (
        <InvitationForm token={token} />
      ) : (
        <FormMessage tone="error">{t('invalid')}</FormMessage>
      )}
    </AuthCard>
  );
}
