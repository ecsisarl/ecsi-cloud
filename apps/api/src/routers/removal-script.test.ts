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
});
