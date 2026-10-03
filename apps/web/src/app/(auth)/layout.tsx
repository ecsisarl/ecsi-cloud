import { getTranslations } from 'next-intl/server';
import type { ReactNode } from 'react';
import { AuthBrand } from '@/components/auth/auth-card';

/** Pages publiques d'authentification : légères, centrées, utilisables sur mobile. */
export default async function AuthLayout({ children }: { children: ReactNode }) {
  const t = await getTranslations('auth');
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-6 bg-background px-4 py-10">
      <AuthBrand tagline={t('brand')} />
      {children}
    </main>
  );
}
