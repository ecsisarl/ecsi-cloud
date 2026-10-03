'use client';

import type { MeResponse } from '@ecsi/shared';
import { createContext, type ReactNode, useContext } from 'react';

const MeContext = createContext<MeResponse | null>(null);

export function MeProvider({ me, children }: { me: MeResponse; children: ReactNode }) {
  return <MeContext.Provider value={me}>{children}</MeContext.Provider>;
}

/** Session courante (fournie par le layout du dashboard). */
export function useMe(): MeResponse {
  const me = useContext(MeContext);
  if (!me) throw new Error('useMe() hors du dashboard');
  return me;
}

/**
 * Permissions de l'utilisateur pour l'affichage (boutons, liens). L'API reste la seule
 * autorité : un bouton masqué n'est qu'un confort, jamais une protection.
 */
export function usePermissions() {
  const me = useMe();
  return {
    any: (permission: string) => me.permissions.includes(permission),
    companyWide: (permission: string) => me.companyPermissions.includes(permission),
  };
}
