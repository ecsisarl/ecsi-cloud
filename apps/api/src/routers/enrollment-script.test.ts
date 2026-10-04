import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  buildEnrollmentScript,
  ENROLLMENT_SCRIPT_BODY,
  EnrollmentScriptError,
  type EnrollmentScriptInput,
} from './enrollment-script.js';

const LAB_TEMPLATE = fileURLToPath(
  new URL('../../../../lab/routeros/enrolement/ecsi-enrolement.rsc.modele', import.meta.url),
);

const base: EnrollmentScriptInput = {
  token: 'A'.repeat(42) + 'b',
  enrollUrl: 'https://cloud.ecsi.example/api/v1/routers/enroll',
  gatewayTunnelIp: '10.200.0.1',
  activationPort: 8081,
  gatewayPublicKey: 'devonlyWireGuardPublicKeyForTests000000000A=',
  gatewayEndpoint: 'vpn.ecsi.example',
  gatewayPort: 51820,
  tunnelIp: '10.200.0.3',
  tunnelPrefix: 24,
  ttlMinutes: 30,
};

describe('script d’enrôlement RouterOS', () => {
  it('reprend À L’IDENTIQUE le corps du modèle validé sur CHR 7.24.5 (variante labo)', () => {
    const lab = readFileSync(LAB_TEMPLATE, 'utf8');
    expect(ENROLLMENT_SCRIPT_BODY).toBe(lab.slice(lab.indexOf('\n{\n') + 1));
    const ca = { url: 'https://203.0.113.30:8443/ca.pem', fingerprint: 'ab'.repeat(32) };
    const script = buildEnrollmentScript({ ...base, ca });
    const expected = ENROLLMENT_SCRIPT_BODY.replaceAll('__TOKEN__', base.token)
      .replaceAll('__ENROLL_URL__', base.enrollUrl)
      .replaceAll('__ACTIVATE_URL__', 'http://10.200.0.1:8081/activate')
      .replaceAll('__CA_URL__', ca.url)
      .replaceAll('__CA_FINGERPRINT__', ca.fingerprint)
      .replaceAll('__GW_PUBLIC_KEY__', base.gatewayPublicKey)
      .replaceAll('__GW_ENDPOINT__', base.gatewayEndpoint)
      .replaceAll('__GW_PORT__', '51820')
      .replaceAll('__GW_TUNNEL_IP__', '10.200.0.1')
      .replaceAll('__TUNNEL_ADDRESS__', '10.200.0.3/24');
    expect(script.endsWith(expected)).toBe(true);
    expect(script).toContain('usage unique (30 min)');
  });

  it('sans AC de laboratoire : étape 2 retirée, aucune autre commande modifiée', () => {
    const script = buildEnrollmentScript(base);
    expect(script).not.toMatch(/__[A-Z_]+__/);
    expect(script).not.toContain('/certificate/import');
    expect(script).not.toContain('check-certificate=no');
    expect(script).not.toContain('ecsiCaUrl');
    expect(script).toContain('ECSI 2/9: AC publique (magasin integre)');
    // Les étapes 1 et 3 à 9 restent présentes.
    for (const step of [1, 3, 4, 5, 6, 7, 8, 9]) expect(script).toContain(`ECSI ${step}/9`);
    expect(script).toContain('check-certificate=yes');
  });

  it('ne contient ni mot de passe, ni clé privée, ni empreinte de jeton', () => {
    const script = buildEnrollmentScript(base);
    expect(script).not.toMatch(/private-key=/i);
    expect(script).toContain(':local pw [:rndstr length=32]'); // mot de passe tiré PAR le routeur
    expect(script.match(new RegExp(base.token, 'g'))).toHaveLength(1);
  });

  it.each([
    ['token', { token: 'A'.repeat(42) + '"' }],
    ['token', { token: 'A'.repeat(40) + '$x;' }],
    ['enrollUrl', { enrollUrl: 'http://cloud.ecsi.example/enroll' }],
    ['enrollUrl', { enrollUrl: 'https://x.example/a"; /system/reset-configuration' }],
    ['enrollUrl', { enrollUrl: 'https://x.example/$(x)' }],
    ['gatewayEndpoint', { gatewayEndpoint: 'vpn.example"; :put "x' }],
    ['gatewayEndpoint', { gatewayEndpoint: 'vpn example' }],
    ['gatewayPublicKey', { gatewayPublicKey: 'pas une clé' }],
    ['gatewayPort', { gatewayPort: 70000 }],
    ['tunnelIp', { tunnelIp: '10.200.0.3;' }],
    ['tunnelPrefix', { tunnelPrefix: 8 }],
    ['activationPort', { activationPort: 0 }],
    ['ttlMinutes', { ttlMinutes: 2 }],
  ] as const)('refuse une valeur injectable : %s', (_field, override) => {
    expect(() => buildEnrollmentScript({ ...base, ...override })).toThrow(EnrollmentScriptError);
  });

  it('refuse une AC de laboratoire mal formée', () => {
    expect(() =>
      buildEnrollmentScript({
        ...base,
        ca: { url: 'https://x.example/ca.pem', fingerprint: 'AB' },
      }),
    ).toThrow(EnrollmentScriptError);
  });
});
