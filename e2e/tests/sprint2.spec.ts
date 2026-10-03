import { expect, test } from '@playwright/test';
import { login, openMenu, SEED_PASSWORD, setupMfa } from './support';

/**
 * Sprint 2 sur la pile réelle : sites et groupes, portée par site, utilisateurs, journal
 * d'audit, profil d'entreprise et console SUPER_ADMIN. Comptes : jeu de démonstration.
 */
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

test.describe('Sites et groupes de sites', () => {
  test('un gérant d’entreprise crée un site et l’ajoute à un groupe @mobile', async ({
    page,
    isMobile,
  }) => {
    await login(page, 'gerant.a@ecsi.test');
    await expect(page.getByRole('heading', { name: 'Tableau de bord' })).toBeVisible();
    await openMenu(page, isMobile);
    await page.getByRole('link', { name: 'Sites', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Sites', exact: true })).toBeVisible();
    const table = page.getByTestId('sites-table');
    await expect(table.getByRole('link', { name: 'Cocody Riviera' })).toBeVisible();
    await expect(table.getByRole('link', { name: 'Yopougon Selmer' })).toBeVisible();

    const code = `SITE-E2E-${isMobile ? 'M' : 'D'}${String(Date.now()).slice(-5)}`;
    await page.getByRole('button', { name: 'Ajouter un site' }).click();
    await page.getByLabel('Nom').fill(`Abobo ${code}`);
    await page.getByLabel('Code').fill(code);
    await page.getByLabel('Ville').fill('Abidjan');
    await page.getByRole('button', { name: 'Créer le site' }).click();
    await expect(table.getByRole('link', { name: `Abobo ${code}` })).toBeVisible();

    await page.getByLabel('Rechercher').fill(code);
    await expect(table.locator('tbody tr')).toHaveCount(1);

    await page.goto('/groupes-de-sites');
    const group = page.getByTestId('group-GROUPE-ABIDJAN');
    await expect(group.getByText('Cocody Riviera')).toBeVisible();
    await group.getByLabel('Ajouter un site').selectOption({ label: `Abobo ${code} (${code})` });
    await group.getByRole('button', { name: 'Ajouter', exact: true }).click();
    const remove = group.getByRole('button', { name: `Retirer Abobo ${code} du groupe` });
    await expect(remove).toBeVisible();
    await remove.click();
    await expect(remove).toHaveCount(0);
  });

  test('GERANT_SITE_A ne voit que SITE_A, même par URL directe', async ({ page, request }) => {
    await login(page, 'gerant.site-a@ecsi.test');
    await expect(page.getByRole('heading', { name: 'Tableau de bord' })).toBeVisible();
    await page.goto('/sites');
    const table = page.getByTestId('sites-table');
    await expect(table.getByRole('link', { name: 'Cocody Riviera' })).toBeVisible();
    await expect(table.getByText('Yopougon Selmer')).toHaveCount(0);

    // Identifiant de SITE_B obtenu par un compte qui y a droit, puis tentative d'accès direct.
    const sites = await page.request.get('/api/v1/sites');
    expect((await sites.json()) as unknown[]).toHaveLength(1);
    const admin = await request.post('/api/v1/auth/login', {
      data: { email: 'gerant.a@ecsi.test', password: SEED_PASSWORD },
    });
    expect(admin.ok()).toBe(true);
    const all = (await (await request.get('/api/v1/sites')).json()) as {
      id: string;
      code: string;
    }[];
    const siteB = all.find((site) => site.code === 'SITE-B');
    expect(siteB).toBeDefined();
    await page.goto(`/sites/${siteB?.id ?? ''}`);
    await expect(page.getByText('Site introuvable')).toBeVisible();
    expect((await page.request.get(`/api/v1/sites/${siteB?.id ?? ''}`)).status()).toBe(404);
  });

  test('VENDEUR_SITE_B : lecture seule de son site, aucun menu d’administration', async ({
    page,
  }) => {
    await login(page, 'vendeur.site-b@ecsi.test');
    await expect(page.getByRole('heading', { name: 'Tableau de bord' })).toBeVisible();
    const nav = page.getByRole('navigation', { name: 'Navigation principale' }).first();
    await expect(nav.getByRole('link', { name: 'Sites', exact: true })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Utilisateurs' })).toHaveCount(0);
    await expect(nav.getByRole('link', { name: 'Journal d’audit' })).toHaveCount(0);
    await page.goto('/sites');
    await expect(
      page.getByTestId('sites-table').getByRole('link', { name: 'Yopougon Selmer' }),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Ajouter un site' })).toHaveCount(0);
    await page.goto('/administration/audit');
    await expect(page.getByRole('main').getByRole('alert')).toBeVisible();
  });
});

test.describe('Utilisateurs et journal d’audit', () => {
  test('liste filtrée des membres et invitation limitée à un site', async ({ page }) => {
    await login(page, 'gerant.a@ecsi.test');
    await expect(page.getByRole('heading', { name: 'Tableau de bord' })).toBeVisible();
    await page.goto('/administration/utilisateurs');
    const members = page.getByTestId('members-table');
    await expect(members.getByText('vendeur.site-b@ecsi.test')).toBeVisible();
    await page.getByLabel('Rechercher').fill('site-a');
    await expect(members.locator('tbody tr')).toHaveCount(1);
    await expect(members.getByText('gerant.site-a@ecsi.test')).toBeVisible();

    const email = `invite.${String(Date.now())}@ecsi.test`;
    await page.getByRole('button', { name: 'Inviter' }).click();
    await page.getByLabel('Adresse e-mail').fill(email);
    await page.getByLabel('Rôle', { exact: true }).last().selectOption({ label: 'Vendeur' });
    await page.getByLabel('Portée').selectOption('SITES');
    await page.getByRole('checkbox', { name: /Yopougon Selmer/ }).check();
    await page.getByRole('button', { name: 'Envoyer l’invitation' }).click();
    await expect(page.getByRole('main').getByRole('status')).toContainText(email);
    await expect(page.getByTestId('invitations-list').getByText(email)).toBeVisible();
  });

  test('le journal d’audit trace l’invitation, se filtre et affiche le détail sans secret', async ({
    page,
  }) => {
    await login(page, 'gerant.a@ecsi.test');
    await expect(page.getByRole('heading', { name: 'Tableau de bord' })).toBeVisible();
    await page.goto('/administration/audit');
    await expect(page.getByRole('heading', { name: 'Journal d’audit' })).toBeVisible();
    await page.getByLabel('Action').fill('invitations.create');
    const rows = page.getByTestId('audit-table').locator('tbody tr');
    await expect(rows.first()).toContainText('invitations.create');
    await rows.first().click();
    const detail = page.getByTestId('audit-detail');
    await expect(detail).toContainText('Koffi Gérant (A)');
    await expect(detail).toContainText('GERANT');
    await expect(detail).not.toContainText(SEED_PASSWORD);
    await page.getByLabel('Résultat').selectOption('DENIED');
    await expect(rows.first()).toContainText(/Aucun événement|Refusée/);
  });
});

test.describe('Profil de l’entreprise', () => {
  test('l’administrateur modifie le profil et le logo (2FA obligatoire)', async ({ page }) => {
    await login(page, 'admin.b@ecsi.test');
    await expect(page).toHaveURL(/\/securite\/2fa/);
    await setupMfa(page);
    await expect(page.getByRole('heading', { name: 'Tableau de bord' })).toBeVisible();
    await page.goto('/administration/entreprise');
    await expect(page.getByLabel('Devise')).toHaveValue('XOF');
    await expect(page.getByLabel('Pays')).toHaveValue('CI');
    await expect(page.getByLabel('Fuseau horaire')).toHaveValue('Africa/Abidjan');
    await page.getByLabel('Raison sociale').fill('Entreprise B SARL');
    await page.getByLabel('WhatsApp').fill('+225 07 00 00 00 09');
    await page.getByRole('button', { name: 'Enregistrer' }).first().click();
    await expect(page.getByRole('main').getByRole('status').first()).toHaveText(
      'Modifications enregistrées.',
    );

    await page.getByTestId('logo-input').setInputFiles({
      name: 'logo.png',
      mimeType: 'image/png',
      buffer: PNG_1PX,
    });
    await expect(page.getByText('Logo enregistré.')).toBeVisible();
    await expect(page.getByRole('img', { name: 'Logo de ENTREPRISE_B' })).toBeVisible();

    await page.reload();
    await expect(page.getByLabel('Raison sociale')).toHaveValue('Entreprise B SARL');
  });

  test('un gérant consulte le profil en lecture seule', async ({ page }) => {
    await login(page, 'gerant.a@ecsi.test');
    await expect(page.getByRole('heading', { name: 'Tableau de bord' })).toBeVisible();
    await page.goto('/administration/entreprise');
    await expect(page.getByText('Lecture seule')).toBeVisible();
    await expect(page.getByLabel('Nom commercial')).toBeDisabled();
  });
});

test.describe('Console SUPER_ADMIN', () => {
  test('crée, suspend et réactive une entreprise ; chaque action est auditée', async ({
    page,
    browser,
  }) => {
    await page.goto('/plateforme/connexion');
    await page.getByLabel('Adresse e-mail').fill('superadmin@ecsi.test');
    await page.getByLabel('Mot de passe', { exact: true }).fill(SEED_PASSWORD);
    await page.getByRole('button', { name: 'Se connecter' }).click();
    await setupMfa(page);
    await expect(page.getByRole('heading', { name: 'Entreprises clientes' })).toBeVisible();
    await expect(page.getByTestId('companies-table').getByText('ENTREPRISE_A')).toBeVisible();

    const name = `Wifi Zone E2E ${String(Date.now()).slice(-6)}`;
    await page.getByRole('button', { name: 'Nouvelle entreprise' }).click();
    await page.getByLabel('Nom commercial').fill(name);
    await page.getByLabel('E-mail de l’administrateur').fill(`patron.${String(Date.now())}@e2e.ci`);
    await page.getByRole('button', { name: 'Créer et inviter' }).click();
    await expect(page.getByRole('heading', { name })).toBeVisible();
    await expect(page.getByTestId('company-status')).toHaveText('Active');

    await page.getByRole('button', { name: 'Suspendre', exact: true }).click();
    await page.getByLabel('Motif').fill('Test de suspension E2E');
    await page.getByRole('button', { name: 'Suspendre l’entreprise' }).click();
    await expect(page.getByTestId('company-status')).toHaveText('Suspendue');
    await page.getByRole('button', { name: 'Réactiver' }).click();
    await page.getByLabel('Motif').fill('Fin du test E2E');
    await page.getByRole('button', { name: 'Réactiver' }).last().click();
    await expect(page.getByTestId('company-status')).toHaveText('Active');

    await page.getByRole('link', { name: 'Journal', exact: true }).click();
    await page.getByLabel('Action').fill('platform.companies.*');
    const rows = page.getByTestId('audit-table').locator('tbody tr');
    await expect(rows.first()).toContainText('platform.companies.reactivate');
    await expect(rows.nth(1)).toContainText('platform.companies.suspend');
    await expect(rows.nth(2)).toContainText('platform.companies.create');
    await page.getByRole('button', { name: 'Vérifier' }).click();
    await expect(page.getByText(/Chaîne intacte/)).toBeVisible();

    // La session plateforme n'ouvre pas le dashboard d'une entreprise, et inversement.
    await page.goto('/sites');
    await expect(page).toHaveURL(/\/plateforme/);
    const userContext = await browser.newContext();
    const userPage = await userContext.newPage();
    await login(userPage, 'gerant.a@ecsi.test');
    await expect(userPage.getByRole('heading', { name: 'Tableau de bord' })).toBeVisible();
    await userPage.goto('/plateforme');
    await expect(userPage).not.toHaveURL(/\/plateforme$/);
    await userContext.close();
  });
});
