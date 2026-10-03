import { DEFAULT_LOCALE, isSupportedLocale, type Locale } from '@ecsi/shared';

/** Textes du portail captif. Volontairement minimal : chaque octet compte sur réseau faible. */
const MESSAGES = {
  fr: {
    welcome: 'Bienvenue',
    intro: 'Saisissez le code de votre ticket pour accéder à Internet.',
    codeLabel: 'Code du ticket',
    submit: 'Se connecter',
    help: 'Besoin d’aide ?',
    call: 'Appeler',
    whatsapp: 'WhatsApp',
    poweredBy: 'Propulsé par ECSI CLOUD',
    demoNotice: 'Gabarit de démonstration : la connexion sera activée au sprint 7.',
  },
  en: {
    welcome: 'Welcome',
    intro: 'Enter your voucher code to access the Internet.',
    codeLabel: 'Voucher code',
    submit: 'Connect',
    help: 'Need help?',
    call: 'Call',
    whatsapp: 'WhatsApp',
    poweredBy: 'Powered by ECSI CLOUD',
    demoNotice: 'Demo template: login will be enabled in sprint 7.',
  },
} satisfies Record<Locale, Record<string, string>>;

export type PortalMessages = (typeof MESSAGES)[Locale];

/** Choisit la langue à partir de l'en-tête Accept-Language du terminal du client. */
export function resolveLocale(acceptLanguage: string | null): Locale {
  const candidates = (acceptLanguage ?? '')
    .split(',')
    .map((part) => part.split(';')[0]?.trim().slice(0, 2).toLowerCase());
  return candidates.find(isSupportedLocale) ?? DEFAULT_LOCALE;
}

export function messagesFor(locale: Locale): PortalMessages {
  return MESSAGES[locale];
}
