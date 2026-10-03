import { messagesFor, resolveLocale } from './i18n';
import { loginPage } from './templates/login-page';
import { DEFAULT_THEME, type PortalTheme } from './templates/theme';

/**
 * Politique de sécurité du portail : aucun script, aucune ressource externe.
 * `form-action` sera étendu au Sprint 7 à l'URL de login du Hotspot MikroTik.
 */
export const PORTAL_CSP = [
  "default-src 'none'",
  "style-src 'unsafe-inline'",
  "img-src 'self' data:",
  "form-action 'self'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join('; ');

export function renderLoginPage(
  acceptLanguage: string | null,
  theme: PortalTheme = DEFAULT_THEME,
): Response {
  const locale = resolveLocale(acceptLanguage);
  // L'indentation des gabarits est retirée : octets inutiles sur réseau faible.
  const html = loginPage({ locale, theme, t: messagesFor(locale), demo: true })
    .toString()
    .replace(/\n\s*/g, '\n');
  return new Response(html, {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      // Jamais mis en cache : un portail captif ne doit pas être resservi depuis un cache intermédiaire.
      'cache-control': 'no-store',
      'content-security-policy': PORTAL_CSP,
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      vary: 'Accept-Language',
    },
  });
}
