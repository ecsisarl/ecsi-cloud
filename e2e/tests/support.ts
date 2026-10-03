import { createHmac } from 'node:crypto';
import { expect, type Page } from '@playwright/test';

export const SEED_PASSWORD = process.env.SEED_PASSWORD ?? 'devonly-demo-password';
const MAILPIT_URL = process.env.MAILPIT_URL ?? 'http://localhost:8025';

/** TOTP RFC 6238 (SHA-1, 30 s, 6 chiffres) : ce que calcule une application d'authentification. */
export function totp(secret: string, atMs = Date.now()): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const char of secret.replace(/=+$/, '')) {
    bits += alphabet.indexOf(char).toString(2).padStart(5, '0');
  }
  const key = Buffer.from((bits.match(/.{8}/g) ?? []).map((byte) => parseInt(byte, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(atMs / 30_000)));
  const digest = createHmac('sha1', key).update(counter).digest();
  const offset = (digest[digest.length - 1] ?? 0) & 0x0f;
  return ((digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).toString().padStart(6, '0');
}

export async function login(page: Page, email: string, password = SEED_PASSWORD) {
  await page.goto('/connexion');
  await page.getByLabel('Adresse e-mail').fill(email);
  await page.getByLabel('Mot de passe', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Se connecter' }).click();
}

export async function logout(page: Page) {
  await page.getByRole('button', { name: 'Menu du compte' }).first().click();
  await page.getByRole('button', { name: 'Se déconnecter' }).first().click();
  await expect(page).toHaveURL(/\/connexion/);
}

interface MailpitMessage {
  ID: string;
  To: { Address: string }[];
  Created: string;
}

/** Dernier e-mail reçu par Mailpit pour `to` après `since`, et le lien qu'il contient. */
export async function linkFromMail(to: string, path: string, since: Date): Promise<string> {
  for (let attempt = 0; attempt < 40; attempt++) {
    const list = (await (await fetch(`${MAILPIT_URL}/api/v1/messages?limit=50`)).json()) as {
      messages: MailpitMessage[];
    };
    const message = list.messages.find(
      (m) => m.To.some((r) => r.Address === to) && new Date(m.Created) >= since,
    );
    if (message) {
      const detail = (await (
        await fetch(`${MAILPIT_URL}/api/v1/message/${message.ID}`)
      ).json()) as {
        Text: string;
      };
      const match = detail.Text.match(
        new RegExp(`https?://[^\\s]+${path}\\?token=[A-Za-z0-9_-]{43}`),
      );
      if (match) return new URL(match[0]).pathname + new URL(match[0]).search;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Aucun e-mail ${path} reçu pour ${to}`);
}
