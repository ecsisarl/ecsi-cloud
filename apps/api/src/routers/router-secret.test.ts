import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { SecretBox } from '../auth/crypto/secret-box.js';
import { decryptRouterPassword, encryptRouterPassword, routerSecretAad } from './router-secret.js';

const box = new SecretBox(randomBytes(32).toString('base64'));
const routerA = {
  companyId: '0190a000-0000-7000-8000-00000000000a',
  routerId: '0190a000-0000-7000-8000-000000000001',
};

describe('mot de passe RouterOS chiffré (SecretBox + AAD)', () => {
  it('chiffre au format v2 et déchiffre pour le même routeur', () => {
    const payload = encryptRouterPassword(box, routerA, 'Mot-de-passe-RouterOS-42');
    expect(payload.startsWith('v2:k1:')).toBe(true);
    expect(payload).not.toContain('Mot-de-passe');
    expect(decryptRouterPassword(box, routerA, payload)).toBe('Mot-de-passe-RouterOS-42');
  });

  it('un chiffré copié sur un autre routeur ou une autre entreprise est inutilisable', () => {
    const payload = encryptRouterPassword(box, routerA, 'Mot-de-passe-RouterOS-42');
    expect(() =>
      decryptRouterPassword(
        box,
        { ...routerA, routerId: '0190a000-0000-7000-8000-000000000002' },
        payload,
      ),
    ).toThrow();
    expect(() =>
      decryptRouterPassword(
        box,
        { ...routerA, companyId: '0190a000-0000-7000-8000-00000000000b' },
        payload,
      ),
    ).toThrow();
    // Ni sans AAD, ni avec l'AAD d'un secret 2FA.
    expect(() => box.decrypt(payload)).toThrow();
    expect(() => box.decrypt(payload, `mfa:user:${routerA.routerId}`)).toThrow();
  });

  it('lie l’AAD à l’entreprise et au routeur', () => {
    expect(routerSecretAad(routerA)).toBe(
      `router:${routerA.companyId}:${routerA.routerId}:routeros-password`,
    );
  });

  it('reste lisible après rotation de la clé (ré-enveloppe sans déchiffrer le secret)', () => {
    const oldKey = randomBytes(32).toString('base64');
    const old = new SecretBox(oldKey, { id: 'k1' });
    const payload = encryptRouterPassword(old, routerA, 'Mot-de-passe-RouterOS-42');
    const rotated = new SecretBox(randomBytes(32).toString('base64'), {
      id: 'k2',
      previous: [{ id: 'k1', base64: oldKey }],
    });
    const next = rotated.rewrap(payload, routerSecretAad(routerA));
    expect(next.startsWith('v2:k2:')).toBe(true);
    expect(decryptRouterPassword(rotated, routerA, next)).toBe('Mot-de-passe-RouterOS-42');
  });
});
