import { DEFAULT_LOCALE, isSupportedLocale } from '@ecsi/shared';
import { cookies } from 'next/headers';
import { getRequestConfig } from 'next-intl/server';

/**
 * Langue choisie par l'utilisateur (cookie), français par défaut.
 * Ajouter une langue = ajouter messages/<code>.json et l'inscrire dans SUPPORTED_LOCALES.
 */
export const LOCALE_COOKIE = 'ECSI_LOCALE';

export default getRequestConfig(async () => {
  const requested = (await cookies()).get(LOCALE_COOKIE)?.value;
  const locale = isSupportedLocale(requested) ? requested : DEFAULT_LOCALE;
  const messages = (await import(`../../messages/${locale}.json`)) as {
    default: Record<string, unknown>;
  };
  return { locale, messages: messages.default, timeZone: 'Africa/Abidjan' };
});
