import type { RouterStatus } from '../../database/schema/index.js';

/**
 * États de supervision (docs/MIKROTIK.md, mesures du laboratoire S3A) :
 *
 *  - ONLINE   : la dernière collecte a réussi ;
 *  - DEGRADED : la collecte échoue alors que le routeur répond (refus d'authentification,
 *               droits, certificat inattendu, erreur RouterOS, connexion refusée : le tunnel
 *               est donc actif), OU il ne répond plus depuis moins que le seuil OFFLINE ;
 *  - OFFLINE  : aucune réponse depuis au moins `offlineAfterSeconds` (180 s par défaut, la
 *               valeur du laboratoire : un pair sans handshake WireGuard depuis 180 s est
 *               hors ligne ; 2 min de rafraîchissement de clé + marge) ET au moins
 *               `offlineMinFailures` échecs consécutifs. Une erreur transitoire isolée ne
 *               déclare donc jamais un routeur OFFLINE.
 *
 * Un routeur OFFLINE le reste tant qu'il ne répond pas (pas d'oscillation OFFLINE/DEGRADED
 * sur des délais dépassés) ; un nouveau routeur part OFFLINE jusqu'à sa première réponse.
 */
export interface StatusThresholds {
  readonly offlineAfterSeconds: number;
  readonly offlineMinFailures: number;
}

export const DEFAULT_THRESHOLDS: StatusThresholds = {
  offlineAfterSeconds: 180,
  offlineMinFailures: 3,
};

export type PollOutcome = 'success' | 'unreachable' | 'failure';

export interface StatusInput {
  readonly previous: RouterStatus;
  readonly outcome: PollOutcome;
  /** Échecs consécutifs, collecte courante comprise (0 si succès). */
  readonly consecutiveFailures: number;
  /** Dernière collecte réussie, sinon date de création du routeur. */
  readonly lastContactAt: Date;
  readonly now: Date;
}

export function nextStatus(
  input: StatusInput,
  thresholds: StatusThresholds = DEFAULT_THRESHOLDS,
): RouterStatus {
  if (input.outcome === 'success') return 'ONLINE';
  if (input.outcome === 'failure') return 'DEGRADED';
  const silentSeconds = (input.now.getTime() - input.lastContactAt.getTime()) / 1000;
  if (
    input.consecutiveFailures >= thresholds.offlineMinFailures &&
    silentSeconds >= thresholds.offlineAfterSeconds
  ) {
    return 'OFFLINE';
  }
  return input.previous === 'OFFLINE' ? 'OFFLINE' : 'DEGRADED';
}
