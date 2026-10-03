import { expect, test } from '@playwright/test';
import { linkFromMail, login, logout, SEED_PASSWORD, totp } from './support';

test.describe('Parcours de connexion', () => {
  test('protège le dashboard et redirige vers la connexion @mobile', async ({ page }) => {
    await page.goto('/securite/sessions');
    await expect(page).toHaveURL(/\/connexion\?next=%2Fsecurite%2Fsessions/);
    await expect(page.getByRole('heading', { name: 'Connexion' })).toBeVisible();
  });

  test('refuse un mauvais mot de passe avec un message générique', async ({ page }) => {
    await login(page, 'gerant.a@ecsi.test', 'mauvais-mot-de-passe');
    await expect(page.getByRole('main').getByRole('alert')).toHaveText(
      'Adresse e-mail ou mot de passe incorrect.',
    );
    await expect(page).toHaveURL(/\/connexion/);
  });

  test('connecte un vendeur, conserve la session au rechargement, puis déconnecte @mobile', async ({
    page,
    isMobile,
  }) => {
    await login(page, 'vendeur.a@ecsi.test');
    await expect(page.getByRole('heading', { name: 'Tableau de bord' })).toBeVisible();
    if (isMobile) await page.getByRole('button', { name: 'Ouvrir le menu' }).click();
    await expect(page.getByTestId('company-name').first()).toHaveText('ENTREPRISE_A');

    // Les jetons sont dans des cookies httpOnly : invisibles pour le JavaScript de la page.
    const visible = await page.evaluate(() => document.cookie);
    expect(visible).not.toContain('ecsi_at');
    expect(visible).not.toContain('ecsi_rt');

    await page.reload();
    await expect(page.getByRole('heading', { name: 'Tableau de bord' })).toBeVisible();
    if (isMobile) await page.getByRole('button', { name: 'Ouvrir le menu' }).click();
    await logout(page);
    await page.goto('/');
    await expect(page).toHaveURL(/\/connexion/);
  });

  test('rétablit la session par rotation du refresh token quand le jeton d’accès a expiré', async ({
    page,
    context,
  }) => {
    await login(page, 'gerant.a@ecsi.test');
    await expect(page.getByRole('heading', { name: 'Tableau de bord' })).toBeVisible();
    const before = (await context.cookies()).find((c) => c.name === 'ecsi_rt')?.value;
    await context.clearCookies({ name: 'ecsi_at' });
    await page.goto('/securite/sessions');
    await expect(page.getByRole('heading', { name: 'Sessions actives' })).toBeVisible();
    const after = (await context.cookies()).find((c) => c.name === 'ecsi_rt')?.value;
    expect(after).toBeDefined();
    expect(after).not.toBe(before);
    await expect(page.getByTestId('sessions-list').getByText('Cet appareil')).toBeVisible();
  });

  test('impose puis utilise la double authentification (ADMIN_ENTREPRISE)', async ({ page }) => {
    await login(page, 'admin.a@ecsi.test');
    await expect(page).toHaveURL(/\/securite\/2fa/);
    await expect(
      page.getByText('Votre rôle exige l’authentification à deux facteurs.'),
    ).toBeVisible();
    // Toute autre page renvoie vers la configuration tant qu'elle n'est pas faite.
    await page.goto('/');
    await expect(page).toHaveURL(/\/securite\/2fa/);

    await page.getByRole('button', { name: 'Configurer' }).click();
    await expect(page.getByAltText('QR code')).toBeVisible();
    await page.getByText('Saisie manuelle de la clé').click();
    const secret = (await page.getByTestId('totp-secret').textContent())?.trim() ?? '';
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    await page.getByLabel('Code de vérification').fill(totp(secret));
    await page.getByRole('button', { name: 'Activer' }).click();
    await expect(page.getByTestId('recovery-codes').locator('li')).toHaveCount(10);
    await page.getByRole('button', { name: 'J’ai conservé mes codes' }).click();
    await expect(page.getByRole('heading', { name: 'Tableau de bord' })).toBeVisible();

    await logout(page);
    await login(page, 'admin.a@ecsi.test');
    await expect(page.getByText('Vérification en deux étapes')).toBeVisible();
    await page.getByLabel('Code de vérification').fill('000000');
    await page.getByRole('button', { name: 'Vérifier' }).click();
    await expect(page.getByRole('main').getByRole('alert')).toHaveText('Code invalide. Réessayez.');
    // Le code de l'activation ne peut pas être rejoué : on utilise le pas suivant (±30 s toléré).
    await page.getByLabel('Code de vérification').fill(totp(secret, Date.now() + 30_000));
    await page.getByRole('button', { name: 'Vérifier' }).click();
    await expect(page.getByRole('heading', { name: 'Tableau de bord' })).toBeVisible();
  });

  test('réinitialise un mot de passe par e-mail (Mailpit)', async ({ page }) => {
    const email = 'gerant.b@ecsi.test';
    const since = new Date(Date.now() - 1_000);
    await page.goto('/connexion');
    await page.getByRole('link', { name: 'Mot de passe oublié ?' }).click();
    await page.getByLabel('Adresse e-mail').fill(email);
    await page.getByRole('button', { name: 'Envoyer le lien' }).click();
    await expect(page.getByRole('main').getByRole('status')).toContainText(
      'Si un compte correspond',
    );

    const link = await linkFromMail(email, '/reinitialisation', since);
    await page.goto(link);
    const newPassword = `${SEED_PASSWORD}-nouveau`;
    await page.getByLabel('Nouveau mot de passe').fill(newPassword);
    await page.getByLabel('Confirmer le mot de passe').fill(newPassword);
    await page.getByRole('button', { name: 'Enregistrer le mot de passe' }).click();
    await expect(page.getByRole('main').getByRole('status')).toHaveText(
      'Mot de passe modifié. Vous pouvez vous connecter.',
    );

    // Le lien est à usage unique.
    await page.goto(link);
    await page.getByLabel('Nouveau mot de passe').fill(newPassword);
    await page.getByLabel('Confirmer le mot de passe').fill(newPassword);
    await page.getByRole('button', { name: 'Enregistrer le mot de passe' }).click();
    await expect(page.getByRole('main').getByRole('alert')).toContainText('invalide ou a expiré');

    await login(page, email, newPassword);
    await expect(page.getByRole('heading', { name: 'Tableau de bord' })).toBeVisible();
    await expect(page.getByTestId('company-name').first()).toHaveText('ENTREPRISE_B');
  });
});
