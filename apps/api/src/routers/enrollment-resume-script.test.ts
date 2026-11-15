import { describe, expect, it } from 'vitest';
import {
  buildEnrollmentResumeScript,
  EnrollmentResumeScriptError,
} from './enrollment-resume-script.js';

const input = {
  gatewayTunnelIp: '10.200.0.1',
  activationPort: 8081,
  gatewayPublicKey: 'devonlyWireGuardPublicKeyForTests000000000A=',
  gatewayEndpoint: 'vpn.ecsi.test',
  gatewayPort: 51820,
  tunnelIp: '10.200.0.2',
  tunnelPrefix: 24,
  routerPublicKey: 'devonlyWireGuardPublicKeyForTests000000000E=',
};

describe('script de reprise d’enrôlement', () => {
  it('reprend uniquement les étapes 7 à 9 sans jeton ni création WireGuard', () => {
    const script = buildEnrollmentResumeScript(input);

    expect(script).toContain('ECSI 7/9');
    expect(script).toContain('ECSI 8/9');
    expect(script).toContain('ECSI 9/9');
    expect(script).toContain('/activate');

    expect(script).not.toContain('ecsiToken');
    expect(script).not.toContain('/routers/enroll');
    expect(script).not.toContain('/interface/wireguard/add');
    expect(script).not.toContain('/interface/wireguard/peers/add');
  });

  it('lie la reprise à la clé publique et à l’adresse tunnel attendues', () => {
    const script = buildEnrollmentResumeScript(input);

    expect(script).toContain(input.routerPublicKey);
    expect(script).toContain('10.200.0.2/24');
    expect(script).toContain(input.gatewayPublicKey);
    expect(script).toContain(':local gwTunnelIp "10.200.0.1"');
    expect(script).toContain('$gwTunnelIp/32');
  });

  it('vérifie l’identité du routeur avant les étapes 7 à 9', () => {
    const script = buildEnrollmentResumeScript(input);

    const identityCheck = script.indexOf('if ($localPublicKey != $expectedRouterPublicKey)');
    const step7 = script.indexOf('ECSI 7/9');

    expect(identityCheck).toBeGreaterThan(0);
    expect(step7).toBeGreaterThan(identityCheck);
  });

  it('ne remplace jamais automatiquement un compte ecsi-svc existant', () => {
    const script = buildEnrollmentResumeScript(input);

    expect(script).toContain('ecsi-svc existe deja ; reprise automatique refusee');
    expect(script).not.toContain('/user/remove [find where name="ecsi-svc"]\n  :local pw');
  });

  it('retire seulement le compte nouvellement créé si l’activation échoue', () => {
    const script = buildEnrollmentResumeScript(input);

    expect(script).toContain('/user/remove [find where name="ecsi-svc"]');
    expect(script).toContain('activation refusee');
  });

  it('refuse les valeurs injectables ou invalides', () => {
    expect(() =>
      buildEnrollmentResumeScript({
        ...input,
        gatewayEndpoint: 'vpn.ecsi.test"; /system/reset-configuration',
      }),
    ).toThrow(EnrollmentResumeScriptError);

    expect(() =>
      buildEnrollmentResumeScript({
        ...input,
        tunnelIp: '8.8.8.8;put',
      }),
    ).toThrow(EnrollmentResumeScriptError);

    expect(() =>
      buildEnrollmentResumeScript({
        ...input,
        routerPublicKey: 'invalide',
      }),
    ).toThrow(EnrollmentResumeScriptError);
  });

  it('place chaque clé dans sa variable : routeur et passerelle ne peuvent pas être inversés', () => {
    const script = buildEnrollmentResumeScript(input);
    expect(script).toContain(`:local expectedRouterPublicKey "${input.routerPublicKey}"`);
    expect(script).toContain(`:local gwPublicKey "${input.gatewayPublicKey}"`);
  });

  it('vérifie la version, l’identité et le pare-feu AVANT toute modification', () => {
    const script = buildEnrollmentResumeScript(input);
    const step7 = script.indexOf('# 7. Handshake');
    // Les messages d'erreur (consignes à l'opérateur) ne sont pas des commandes exécutées.
    const checks = script
      .slice(0, step7)
      .split('\n')
      .filter((line) => !line.trim().startsWith(':error "'))
      .join('\n');
    expect(checks).toContain('# 1a. Version minimale 7.15');
    expect(checks).toContain('($ecsiMinor < 15)');
    for (const comment of [
      'ecsi-cloud: retours du tunnel',
      'ecsi-cloud: API REST depuis la passerelle',
      'ecsi-cloud: ping depuis la passerelle',
      'ecsi-cloud: tout le reste du tunnel',
      'ecsi-cloud: API REST refusee ailleurs',
    ]) {
      expect(checks).toContain(`"${comment}"`);
    }
    // Aucune commande de modification avant l'étape 7.
    expect(checks).not.toMatch(/\/(add|set|remove|import|sign)\b|\/tool\/fetch/);
  });

  it('compte ecsi-svc déjà présent : consigne explicite, aucune suppression automatique', () => {
    const script = buildEnrollmentResumeScript(input);
    const refusal = script.slice(script.indexOf('ecsi-svc existe deja'));
    expect(refusal).toContain("en cours d'enrolement");
    expect(refusal.slice(0, refusal.indexOf('\n'))).toContain('recoller ce script');
  });

  it('exige un handshake récent (moins de 3 minutes), pas seulement passé', () => {
    const script = buildEnrollmentResumeScript(input);
    expect(script).toContain('public-key=$gwPublicKey last-handshake last-handshake<3m]]');
  });

  it('activation non confirmée : compte conservé sauf refus certain', () => {
    const script = buildEnrollmentResumeScript(input);
    const onError = script.slice(script.indexOf(':onerror e in='));
    const removal = onError.indexOf('/user/remove [find where name="ecsi-svc"]');
    // Le retrait n'a lieu que dans la branche des refus certains.
    expect(onError.slice(0, removal)).toContain('"Status 4"');
    expect(onError.slice(0, removal)).toContain('"Connection refused"');
    expect(onError.slice(0, removal)).toContain('"timeout connecting"');
    expect(onError).toContain('compte de service conserve');
    expect(onError.split('/user/remove').length).toBe(2);
  });

  it('pare-feu : règles actives filtrées par !disabled (disabled=no ne trouve rien sur RouterOS)', () => {
    const script = buildEnrollmentResumeScript(input);
    expect(script).toContain('find where comment=$c !disabled]]');
    expect(script).not.toContain('disabled=no]]');
  });

  it('compte ecsi-svc existant : refus AVANT toute modification (étapes 8 et 9)', () => {
    const script = buildEnrollmentResumeScript(input);
    const refusal = script.indexOf('ecsi-svc existe deja');
    expect(refusal).toBeGreaterThan(0);
    expect(refusal).toBeLessThan(script.indexOf('# 7. Handshake'));
    expect(script.slice(0, script.lastIndexOf('\n', refusal))).not.toMatch(
      /\/(add|set|remove|import|sign)\b|\/tool\/fetch/,
    );
  });
});
