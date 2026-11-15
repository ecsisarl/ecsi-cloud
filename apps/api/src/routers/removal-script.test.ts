import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ROUTER_REMOVAL_SCRIPT, ROUTER_REMOVAL_SCRIPT_BODY } from '@ecsi/shared';
import { describe, expect, it } from 'vitest';

const LAB_REMOVAL = fileURLToPath(
  new URL('../../../../lab/routeros/enrolement/ecsi-retrait.rsc', import.meta.url),
);

describe('script de retrait RouterOS (ré-enrôlement)', () => {
  it('reprend À L’IDENTIQUE le corps du modèle validé sur CHR 7.24.5', () => {
    const lab = readFileSync(LAB_REMOVAL, 'utf8');
    expect(ROUTER_REMOVAL_SCRIPT_BODY).toBe(lab.slice(lab.indexOf('\n{\n') + 1));
    expect(ROUTER_REMOVAL_SCRIPT.endsWith(ROUTER_REMOVAL_SCRIPT_BODY)).toBe(true);
  });

  it('ne retire que les objets créés par l’enrôlement et ne contient aucun secret', () => {
    for (const line of ROUTER_REMOVAL_SCRIPT_BODY.split('\n')) {
      if (line.includes('/remove')) expect(line).toMatch(/ecsi/);
    }
    expect(ROUTER_REMOVAL_SCRIPT).not.toMatch(/password=|private-key|__[A-Z_]+__/);
    // L'en-tête n'est fait que de commentaires.
    const header = ROUTER_REMOVAL_SCRIPT.slice(0, -ROUTER_REMOVAL_SCRIPT_BODY.length);
    for (const line of header.split('\n').filter(Boolean)) expect(line.startsWith('#')).toBe(true);
  });

  it('retire aussi le Hotspot (lot B) puis ecsi-cfg et ecsi-rw, avant ecsi-svc', () => {
    const body = ROUTER_REMOVAL_SCRIPT_BODY;
    const order = [
      '/ip/hotspot/remove [find where name~"^ecsi-hs-"]',
      '/ip/hotspot/profile/remove [find where name~"^ecsi-hs-"]',
      '/ip/firewall/nat/remove [find where comment~"^ecsi-cloud:hs:"]',
      '/radius/remove [find where comment~"^ecsi-cloud:hs:"]',
      '/ip/dhcp-server/remove [find where comment~"^ecsi-cloud:hs:"]',
      '/ip/dhcp-server/network/remove [find where comment~"^ecsi-cloud:hs:"]',
      '/ip/pool/remove [find where comment~"^ecsi-cloud:hs:"]',
      '/ip/address/remove [find where comment~"^ecsi-cloud:hs:"]',
      '/user/remove [find where name="ecsi-cfg"]',
      '/user/group/remove [find where name="ecsi-rw"]',
      'ecsi-svc',
    ].map((line) => body.indexOf(line));
    expect(order.every((at) => at > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // Règles de filtrage étiquetées « ecsi-cloud » : déjà couvertes par le motif général.
    expect(body).toMatch(/\/ip\/firewall\/filter\/remove \[find where comment~"\^ecsi-cloud"\]/);
  });
});
