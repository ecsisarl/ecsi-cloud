import { defineConfig, devices } from '@playwright/test';

/**
 * E2E sur la pile réelle (docker compose up) : Nginx -> dashboard Next.js -> API -> PostgreSQL,
 * Redis, Mailpit. Aucune API simulée. Prérequis : comptes de démonstration créés (db:seed).
 *
 *   E2E_BASE_URL (défaut http://localhost:8080), MAILPIT_URL (défaut http://localhost:8025),
 *   SEED_PASSWORD (mot de passe des comptes de démonstration).
 *   PLAYWRIGHT_CHROMIUM_PATH : navigateur déjà installé (sinon `playwright install chromium`).
 */
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH;

export default defineConfig({
  testDir: './tests',
  // Les scénarios partagent les comptes de démonstration : exécution séquentielle.
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 60_000,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:8080',
    locale: 'fr-FR',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        ...(executablePath ? { launchOptions: { executablePath } } : {}),
      },
    },
    {
      name: 'mobile',
      use: {
        ...devices['Pixel 7'],
        ...(executablePath ? { launchOptions: { executablePath } } : {}),
      },
      grep: /@mobile/,
    },
  ],
});
