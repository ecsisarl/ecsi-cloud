import type { Locale } from '@ecsi/shared';
import type { PortalMessages } from '../i18n';
import { html, type SafeHtml, unsafeRaw } from './html';
import { portalCss } from './styles';
import type { PortalTheme } from './theme';

export interface LoginPageProps {
  locale: Locale;
  theme: PortalTheme;
  t: PortalMessages;
  /** Tant que l'intégration Hotspot (Sprint 7) n'existe pas, le formulaire est désactivé. */
  demo: boolean;
}

/** Page de connexion du portail captif : HTML statique, aucun JavaScript envoyé au client. */
export function loginPage({ locale, theme, t, demo }: LoginPageProps): SafeHtml {
  const initial = theme.brandName.trim().charAt(0).toUpperCase() || 'W';
  const disabled = demo ? unsafeRaw(' disabled') : '';
  const help =
    theme.phone || theme.whatsapp
      ? html`<div class="h">
          ${t.help}<br />${theme.phone ? html`<a href="tel:${theme.phone}">${t.call}</a>` : ''}${
            theme.whatsapp
              ? html`<a href="https://wa.me/${theme.whatsapp.replace(/\D/g, '')}">${t.whatsapp}</a>`
              : ''
          }
        </div>`
      : '';

  return html`<!doctype html>
    <html lang="${locale}">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        <meta name="robots" content="noindex" />
        <title>${theme.wifiName}</title>
        <style>
          ${unsafeRaw(portalCss(theme.primaryColor))}
        </style>
      </head>
      <body>
        <main class="w">
          <div class="c">
            <div class="b">
              <div class="l" aria-hidden="true">${initial}</div>
              <div>
                <div class="n">${theme.brandName}</div>
                <div class="s">${theme.wifiName}</div>
              </div>
            </div>
            ${
              demo ? html`<div class="d">${t.demoNotice}</div>` : ''
            }${theme.promotion ? html`<div class="pr">${theme.promotion}</div>` : ''}
            <h1>${t.welcome}</h1>
            <p>${theme.message ?? t.intro}</p>
            <form method="post" action="#">
              <label for="code">${t.codeLabel}</label
              ><input
                id="code"
                name="username"
                type="text"
                inputmode="text"
                autocomplete="off"
                autocapitalize="characters"
                spellcheck="false"
                required${disabled}
              /><button type="submit" ${disabled}>${t.submit}</button>
            </form>
            ${help}
          </div>
          <div class="f">${t.poweredBy}</div>
        </main>
      </body>
    </html>`;
}
