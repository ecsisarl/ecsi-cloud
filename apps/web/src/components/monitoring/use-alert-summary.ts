'use client';

import type { AlertSummary } from '@ecsi/shared';
import { useEffect, useState } from 'react';
import { api } from '@/lib/client-api';

/** Événement émis après un acquittement : l'indicateur de l'en-tête se met à jour aussitôt. */
export const ALERTS_CHANGED_EVENT = 'ecsi:alerts-changed';

/** Intervalle de rafraîchissement de l'indicateur (le worker collecte toutes les 60 s). */
const REFRESH_MS = 60_000;

export function notifyAlertsChanged(): void {
  window.dispatchEvent(new Event(ALERTS_CHANGED_EVENT));
}

/**
 * Compteurs d'alertes ouvertes pour l'indicateur de navigation, rafraîchis toutes les
 * minutes, au retour sur l'onglet et après un acquittement. `enabled` : l'utilisateur détient
 * monitoring.read (sinon aucun appel, l'API répondrait 403).
 */
export function useAlertSummary(enabled: boolean): AlertSummary | null {
  const [summary, setSummary] = useState<AlertSummary | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let active = true;
    const load = () => {
      if (document.visibilityState === 'hidden') return;
      void api<AlertSummary>('/monitoring/alerts/summary').then((result) => {
        if (active && result.ok) setSummary(result.data);
      });
    };
    load();
    const timer = setInterval(load, REFRESH_MS);
    window.addEventListener(ALERTS_CHANGED_EVENT, load);
    document.addEventListener('visibilitychange', load);
    return () => {
      active = false;
      clearInterval(timer);
      window.removeEventListener(ALERTS_CHANGED_EVENT, load);
      document.removeEventListener('visibilitychange', load);
    };
  }, [enabled]);

  return enabled ? summary : null;
}
