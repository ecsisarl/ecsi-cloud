/**
 * Healthcheck Docker des processus sans HTTP : `node dist/healthcheck.js worker` (worker de
 * supervision) ou `node dist/healthcheck.js gateway` (agent passerelle). Code de sortie 0 si
 * le dernier cycle réussi est assez récent, 1 sinon. Voir health/heartbeat.ts.
 */
import {
  checkHeartbeat,
  HEARTBEATS,
  heartbeatPath,
  type HeartbeatName,
} from './health/heartbeat.js';

const name = process.argv[2];
if (name !== 'worker' && name !== 'gateway') {
  process.stderr.write('usage : node dist/healthcheck.js worker|gateway\n');
  process.exit(2);
}
const target: HeartbeatName = name;
const state = checkHeartbeat(heartbeatPath(target), HEARTBEATS[target].maxAgeMs);
if (state.healthy) {
  process.stdout.write(
    `${target} : OK (dernier cycle il y a ${Math.round(state.ageMs / 1000)} s)\n`,
  );
} else {
  process.stderr.write(`${target} : ${state.reason}\n`);
  process.exit(1);
}
