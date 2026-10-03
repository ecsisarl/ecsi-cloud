/**
 * Les montants sont toujours manipulés en entiers, dans l'unité mineure de la devise
 * (voir docs/DATABASE.md). Le franc CFA d'Afrique de l'Ouest (FCFA) a pour code ISO 4217
 * « XOF » et ne possède pas de subdivision : 500 FCFA = 500 unités mineures.
 */
export const DEFAULT_CURRENCY = 'XOF';

/** Nombre de décimales des devises prises en charge (ISO 4217). */
const CURRENCY_DECIMALS: Readonly<Record<string, number>> = {
  XOF: 0,
  XAF: 0,
  GNF: 0,
  EUR: 2,
  USD: 2,
  GHS: 2,
  NGN: 2,
};

export function currencyDecimals(currency: string): number {
  const decimals = CURRENCY_DECIMALS[currency.toUpperCase()];
  if (decimals === undefined) {
    throw new Error(`Devise non prise en charge : ${currency}`);
  }
  return decimals;
}

export function isSupportedCurrency(currency: string): boolean {
  return CURRENCY_DECIMALS[currency.toUpperCase()] !== undefined;
}

/** Convertit un montant saisi (ex. 12.5 EUR) en unités mineures entières (1250). */
export function toMinorUnits(amount: number, currency: string): number {
  if (!Number.isFinite(amount)) {
    throw new Error('Montant invalide');
  }
  const minor = Math.round(amount * 10 ** currencyDecimals(currency));
  if (!Number.isSafeInteger(minor)) {
    throw new Error('Montant hors limites');
  }
  return minor;
}

export function fromMinorUnits(minor: number, currency: string): number {
  if (!Number.isSafeInteger(minor)) {
    throw new Error('Le montant en unités mineures doit être un entier');
  }
  return minor / 10 ** currencyDecimals(currency);
}

/**
 * Formate un montant pour l'affichage. Le XOF est affiché « FCFA » (usage local)
 * plutôt que le symbole « F CFA » variable selon les navigateurs.
 */
export function formatMoney(
  minor: number,
  currency: string = DEFAULT_CURRENCY,
  locale = 'fr-FR',
): string {
  const code = currency.toUpperCase();
  const value = fromMinorUnits(minor, code);
  if (code === 'XOF') {
    const formatted = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(value);
    return `${formatted} FCFA`;
  }
  return new Intl.NumberFormat(locale, { style: 'currency', currency: code }).format(value);
}
