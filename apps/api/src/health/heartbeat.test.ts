import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkHeartbeat, HEARTBEATS, heartbeatPath, writeHeartbeat } from './heartbeat.js';

const dirs: string[] = [];
const dir = () => {
  const d = mkdtempSync(join(tmpdir(), 'ecsi-hb-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('battement de cœur (healthcheck worker / passerelle)', () => {
  it('sain juste après un cycle réussi, malsain au-delà de l’âge maximal', () => {
    const path = heartbeatPath('worker', dir());
    const t0 = new Date('2026-10-05T12:00:00Z');
    writeHeartbeat(path, t0);
    expect(checkHeartbeat(path, 300_000, new Date(t0.getTime() + 299_000))).toEqual({
      healthy: true,
      ageMs: 299_000,
    });
    const stale = checkHeartbeat(path, 300_000, new Date(t0.getTime() + 301_000));
    expect(stale).toMatchObject({ healthy: false });
  });

  it('malsain sans fichier (aucun cycle réussi) ou avec un contenu illisible', () => {
    const d = dir();
    expect(checkHeartbeat(heartbeatPath('gateway', d), 90_000)).toMatchObject({ healthy: false });
    const path = join(d, 'x.heartbeat');
    writeFileSync(path, 'n’importe quoi');
    expect(checkHeartbeat(path, 90_000)).toEqual({ healthy: false, reason: 'battement illisible' });
  });

  it('un fichier par processus, dans le répertoire temporaire par défaut', () => {
    expect(heartbeatPath('worker')).toBe(join(tmpdir(), HEARTBEATS.worker.file));
    expect(heartbeatPath('gateway')).not.toBe(heartbeatPath('worker'));
  });
});
