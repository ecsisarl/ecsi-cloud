import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Battement de cœur des processus sans serveur HTTP (worker de supervision, agent
 * passerelle) : chaque cycle RÉUSSI écrit l'heure dans un fichier local, que le healthcheck
 * Docker (`node dist/healthcheck.js worker|gateway`) compare à un âge maximal. Un processus
 * bloqué, ou qui n'atteint plus PostgreSQL, cesse de battre et devient « unhealthy ».
 * Aucune donnée de routeur ni aucun secret dans ce fichier.
 */
export const HEARTBEATS = {
  /** Cycle de supervision toutes les 5 s ; un cycle chargé (100 routeurs) reste sous 5 min. */
  worker: { file: 'ecsi-worker.heartbeat', maxAgeMs: 300_000 },
  /** Synchronisation des pairs toutes les GATEWAY_SYNC_INTERVAL_SECONDS (5 s par défaut). */
  gateway: { file: 'ecsi-gateway.heartbeat', maxAgeMs: 90_000 },
} as const;

export type HeartbeatName = keyof typeof HEARTBEATS;

export function heartbeatPath(name: HeartbeatName, dir: string = tmpdir()): string {
  return join(dir, HEARTBEATS[name].file);
}

/** Écriture atomique (fichier temporaire puis renommage) : jamais de lecture d'un fichier à moitié écrit. */
export function writeHeartbeat(path: string, now: Date = new Date()): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${now.toISOString()}\n`, { mode: 0o644 });
  renameSync(tmp, path);
}

/** Battement après un cycle réussi : un échec d'écriture est journalisé, jamais fatal. */
export function beat(path: string, logger: { warn: (message: string) => void }): void {
  try {
    writeHeartbeat(path);
  } catch (error) {
    logger.warn(
      `Battement de cœur non écrit (${path}) : ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export type HeartbeatState = { healthy: true; ageMs: number } | { healthy: false; reason: string };

export function checkHeartbeat(
  path: string,
  maxAgeMs: number,
  now: Date = new Date(),
): HeartbeatState {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8').trim();
  } catch {
    return { healthy: false, reason: 'aucun battement (cycle jamais réussi)' };
  }
  const at = Date.parse(raw);
  if (Number.isNaN(at)) return { healthy: false, reason: 'battement illisible' };
  const ageMs = now.getTime() - at;
  if (ageMs > maxAgeMs) {
    return {
      healthy: false,
      reason: `dernier cycle réussi il y a ${Math.round(ageMs / 1000)} s (maximum ${maxAgeMs / 1000} s)`,
    };
  }
  return { healthy: true, ageMs };
}
