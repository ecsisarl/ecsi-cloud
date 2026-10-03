/**
 * Personnalisation du portail par entreprise ou par site (cahier des charges §18).
 * Au Sprint 7, ces valeurs proviendront de la table portal_configs.
 */
export interface PortalTheme {
  brandName: string;
  wifiName: string;
  primaryColor: string;
  message?: string;
  phone?: string;
  whatsapp?: string;
  promotion?: string;
}

export const DEFAULT_THEME: PortalTheme = {
  brandName: 'ECSI WiFi',
  wifiName: 'ECSI WiFi Zone',
  primaryColor: '#1d4ed8',
};

const HEX_COLOR = /^#[0-9a-f]{6}$/i;

/** Une couleur non conforme est remplacée : elle est injectée dans le CSS de la page. */
export function safeColor(value: string): string {
  return HEX_COLOR.test(value) ? value : DEFAULT_THEME.primaryColor;
}
