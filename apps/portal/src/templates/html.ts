/**
 * Mini moteur de gabarits HTML sans dépendance. Toute valeur interpolée est échappée,
 * sauf si elle provient elle-même de `html` (fragment déjà sûr). Le portail n'utilise
 * pas React côté client : les pages sont du HTML pur, le plus léger possible.
 */
export class SafeHtml {
  constructor(readonly value: string) {}
  toString(): string {
    return this.value;
  }
}

type Interpolation = SafeHtml | string | number | boolean | null | undefined | Interpolation[];

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ESCAPES[char] ?? char);
}

function render(value: Interpolation): string {
  if (value === null || value === undefined || value === false || value === true) return '';
  if (value instanceof SafeHtml) return value.value;
  if (Array.isArray(value)) return value.map(render).join('');
  return escapeHtml(String(value));
}

export function html(strings: TemplateStringsArray, ...values: Interpolation[]): SafeHtml {
  let out = strings[0] ?? '';
  values.forEach((value, index) => {
    out += render(value) + (strings[index + 1] ?? '');
  });
  return new SafeHtml(out);
}

/** Insère du contenu de confiance, déjà validé (ex. CSS généré à partir de couleurs vérifiées). */
export function unsafeRaw(value: string): SafeHtml {
  return new SafeHtml(value);
}
