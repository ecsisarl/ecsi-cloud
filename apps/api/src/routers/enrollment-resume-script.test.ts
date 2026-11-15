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
  routerPublicKey: 'devonlyWireGuardPublicKeyForTests000000000A=',
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
});
