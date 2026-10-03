import { describe, expect, it } from 'vitest';
import { resolveLocale } from './i18n';
import { renderLoginPage } from './render';
import { safeColor } from './templates/theme';

/** Budget de poids de la page de connexion (HTML + CSS, non compressé). */
const MAX_HTML_BYTES = 12 * 1024;

describe('portail captif', () => {
  it('rend une page HTML complète sans aucun script', async () => {
    const response = renderLoginPage('fr-FR,fr;q=0.9');
    const html = await response.text();
    expect(html).toMatch(/^<!doctype html>\s*<html lang="fr">/);
    expect(html).toContain('name="viewport"');
    expect(html).not.toMatch(/<script/i);
    expect(response.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('respecte le budget de poids pour les connexions lentes', async () => {
    const html = await renderLoginPage(null).text();
    expect(new TextEncoder().encode(html).length).toBeLessThan(MAX_HTML_BYTES);
  });

  it('n’envoie aucune ressource externe (CSS, police, image)', async () => {
    const html = await renderLoginPage(null).text();
    expect(html).not.toMatch(/<link|src="http|url\(http/i);
  });

  it('désactive le formulaire tant que le Hotspot n’est pas intégré (sprint 7)', async () => {
    const html = await renderLoginPage('fr').text();
    expect(html).toContain('sprint 7');
    expect(html).toMatch(/<button[^>]*disabled/);
  });

  it('choisit la langue du terminal, français par défaut', () => {
    expect(resolveLocale('en-US,en;q=0.9')).toBe('en');
    expect(resolveLocale('de-DE')).toBe('fr');
    expect(resolveLocale(null)).toBe('fr');
  });

  it('neutralise une couleur de thème invalide (injection CSS)', async () => {
    expect(safeColor('red;}body{display:none')).toBe('#1d4ed8');
    const html = await renderLoginPage(null, {
      brandName: '<b>X</b>',
      wifiName: 'Zone',
      primaryColor: '}</style><script>alert(1)</script>',
    }).text();
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;b&gt;X&lt;/b&gt;');
  });
});

describe('gabarits HTML', () => {
  it('échappe les valeurs interpolées', async () => {
    const { html, escapeHtml } = await import('./templates/html');
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe(
      '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;',
    );
    expect(html`<p>${'<i>'}</p>`.toString()).toBe('<p>&lt;i&gt;</p>');
    expect(html`<p>${html`<i>ok</i>`}</p>`.toString()).toBe('<p><i>ok</i></p>');
  });
});
