import { expect, test } from '@playwright/test';
import { login } from './support';

/**
 * Lot B sur la pile réelle : forfaits, génération et impression de tickets, page Hotspots.
 * Prérequis : clés des tickets présentes dans l'environnement de l'API (valeurs « devonly »
 * du Compose de développement). Aucun routeur réel : la page Hotspots est seulement affichée.
 */
test.describe('Lot B : forfaits, tickets et hotspots', () => {
  test('un gérant crée un forfait, génère 3 tickets et imprime le lot', async ({ page }) => {
    const suffix = String(Date.now()).slice(-6);
    const planName = `1 heure E2E ${suffix}`;
    const batchLabel = `Kiosque E2E ${suffix}`;

    await login(page, 'gerant.a@ecsi.test');
    await expect(page.getByRole('heading', { name: 'Tableau de bord' })).toBeVisible();

    // Forfait : 1 heure de connexion, 200 FCFA.
    await page.goto('/forfaits');
    await expect(page.getByRole('heading', { name: 'Forfaits', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Nouveau forfait' }).click();
    const form = page.getByTestId('plan-form');
    await form.getByLabel('Nom du forfait').fill(planName);
    await form.getByLabel(/^Prix/).fill('200');
    await form.getByLabel('Durée de connexion', { exact: true }).fill('1');
    await form.getByLabel('Durée de connexion (unité)').selectOption({ label: 'heures' });
    await form.getByRole('button', { name: 'Créer le forfait' }).click();
    await expect(page.getByRole('row').filter({ hasText: planName })).toBeVisible();

    // Lot de 3 tickets sur le premier site du périmètre.
    await page.goto('/tickets');
    await page.getByRole('button', { name: 'Générer des tickets' }).click();
    const generate = page.getByTestId('generate-form');
    await generate.getByLabel('Forfait').selectOption({ label: planName });
    await generate.getByLabel('Site').selectOption({ index: 1 });
    await generate.getByLabel('Nombre de tickets').fill('3');
    await generate.getByLabel('Libellé (facultatif)').fill(batchLabel);
    await generate.getByRole('button', { name: 'Générer', exact: true }).click();
    await expect(page.getByText(`3 tickets générés pour « ${planName} »`)).toBeVisible();

    // La liste ne montre jamais de code : seulement l'impression explicite.
    const row = page
      .getByRole('row')
      .filter({ hasText: batchLabel })
      .filter({ has: page.getByRole('link', { name: 'Imprimer' }) });
    await expect(row).toBeVisible();
    await row.getByRole('link', { name: 'Imprimer' }).click();
    await expect(page).toHaveURL(/\/tickets\/impression\/[0-9a-f-]{36}$/);
    const sheet = page.getByTestId('print-sheet');
    await expect(sheet.getByTestId('printed-ticket')).toHaveCount(3);
    const codes = await sheet.getByTestId('ticket-code').allTextContents();
    expect(codes).toHaveLength(3);
    expect(new Set(codes).size).toBe(3);
    for (const code of codes) expect(code.trim().length).toBeGreaterThanOrEqual(8);
    // Le code n'apparaît pas dans l'URL de la page d'impression.
    for (const code of codes) expect(page.url()).not.toContain(code.replace(/\s|-/g, ''));

    // Retour à la liste : ni les lots ni les tickets n'affichent de code.
    await page.goto('/tickets');
    await expect(page.getByRole('row').filter({ hasText: batchLabel }).first()).toBeVisible();
    const listing = (await page.locator('main').textContent()) ?? '';
    for (const code of codes) expect(listing).not.toContain(code.trim());
  });

  test('la page Réseau → Hotspots s’affiche', async ({ page }) => {
    await login(page, 'gerant.a@ecsi.test');
    await expect(page.getByRole('heading', { name: 'Tableau de bord' })).toBeVisible();
    await page.goto('/reseau/hotspots');
    await expect(page.getByRole('heading', { name: 'Hotspots', exact: true })).toBeVisible();
    await expect(page.getByText('HTTP-CHAP').first()).toBeVisible();
  });
});
