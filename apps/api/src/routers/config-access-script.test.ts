import { describe, expect, it } from 'vitest';
import {
  buildConfigAccessScript,
  CONFIG_ACCESS_SCRIPT_BODY,
  CONFIG_GROUP_POLICY,
  ConfigAccessScriptError,
  type ConfigAccessScriptInput,
} from './config-access-script.js';

const input: ConfigAccessScriptInput = {
  token: 'A'.repeat(43),
  gatewayTunnelIp: '10.200.0.1',
  activationPort: 8090,
  gatewayPublicKey: '2IJ1elaKWeGlTxZJtcjLsIhDXXY3nfwutTlwPHAs1EE=',
  tunnelIp: '10.200.0.2',
  tunnelPrefix: 24,
  ttlMinutes: 60,
};

describe('script d’activation du compte de configuration ecsi-cfg', () => {
  it('remplit le modèle (validé sur CHR 7.24.5 au lot B) sans marque restante', () => {
    const script = buildConfigAccessScript(input);
    expect(script).not.toMatch(/__[A-Z_]+__/);
    expect(script).toContain(`:local ecsiToken "${input.token}"`);
    expect(script).toContain(':local ecsiActivateUrl "http://10.200.0.1:8090/activate-config"');
    expect(script).toContain(':local tunnelAddress "10.200.0.2/24"');
    expect(script).toContain(`:local gwPublicKey "${input.gatewayPublicKey}"`);
    // Corps identique au modèle hors valeurs : seules les marques sont remplacées.
    expect(script.split('\n').length).toBe(
      script.slice(0, script.indexOf('{\n')).split('\n').length +
        CONFIG_ACCESS_SCRIPT_BODY.split('\n').length -
        1,
    );
  });

  it('politique minimale : jamais sensitive, policy, password, ssh, winbox, ftp ni reboot', () => {
    expect(CONFIG_GROUP_POLICY.split(',').sort()).toEqual(['api', 'read', 'rest-api', 'write']);
    const script = buildConfigAccessScript(input);
    expect(script).toContain(`policy=${CONFIG_GROUP_POLICY}`);
    expect(script).not.toMatch(/sensitive|policy=.*(ssh|winbox|ftp|reboot|password|policy,)/);
  });

  it('compte limité à la passerelle, mot de passe généré sur le routeur et jamais écrit', () => {
    const script = buildConfigAccessScript(input);
    expect(script).toContain('address="$gwTunnelIp/32"');
    expect(script).toContain(':local pw [:rndstr length=32]');
    expect(script).not.toMatch(/password="/);
    // L'activation passe par le tunnel (adresse de la passerelle), jamais par Internet.
    expect(script).toMatch(/\/tool\/fetch url=\$ecsiActivateUrl/);
    expect(script).not.toMatch(/https?:\/\/(?!10\.200\.0\.1:)/);
  });

  it('gardes avant toute modification : routeur enrôlé auprès de cette instance', () => {
    const body = CONFIG_ACCESS_SCRIPT_BODY;
    const firstChange = body.indexOf('/user/group/add');
    for (const guard of [
      'routeur non enrole',
      'adresse tunnel inattendue',
      'passerelle inattendue',
      'compte de supervision ecsi-svc absent',
    ]) {
      const at = body.indexOf(guard);
      expect(at).toBeGreaterThan(0);
      expect(at).toBeLessThan(firstChange);
    }
    // Activation refusée : le compte créé est retiré.
    expect(body).toMatch(/do=\{\n {2}\/user\/remove \[find where name="ecsi-cfg"\]/);
  });

  it.each([
    ['token', { token: 'A'.repeat(42) }],
    ['token', { token: `${'A'.repeat(42)}"` }],
    ['token', { token: `${'A'.repeat(40)}";\n` }],
    ['gatewayTunnelIp', { gatewayTunnelIp: '10.200.0.1"; /system/reboot; "' }],
    ['gatewayTunnelIp', { gatewayTunnelIp: 'gw.example' }],
    ['gatewayPublicKey', { gatewayPublicKey: 'pas une clé' }],
    ['tunnelIp', { tunnelIp: '10.200.0.2/24' }],
    ['tunnelPrefix', { tunnelPrefix: 8 }],
    ['activationPort', { activationPort: 0 }],
    ['activationPort', { activationPort: 8090.5 }],
    ['ttlMinutes', { ttlMinutes: 100_000 }],
  ])('refuse une valeur injectable ou invalide (%s)', (field, override) => {
    expect(() => buildConfigAccessScript({ ...input, ...override })).toThrow(
      new ConfigAccessScriptError(field),
    );
  });
});
