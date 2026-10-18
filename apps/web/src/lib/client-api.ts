import { API_PREFIX, AUTH_COOKIES, CSRF_HEADER, type ProblemDetails } from '@ecsi/shared';

/**
 * Appels de l'API depuis le navigateur (même origine : /api/v1).
 *  - les jetons sont dans des cookies httpOnly, envoyés automatiquement ;
 *  - le jeton CSRF (cookie lisible) est recopié dans l'en-tête X-CSRF-Token ;
 *  - un 401 déclenche UN rafraîchissement (partagé entre appels simultanés), puis un nouvel essai.
 */
export type ApiResult<T> =
  | { readonly ok: true; readonly status: number; readonly data: T }
  | { readonly ok: false; readonly status: number; readonly problem: ProblemDetails | null };

function readCookie(name: string): string | undefined {
  return document.cookie
    .split('; ')
    .find((part) => part.startsWith(`${name}=`))
    ?.slice(name.length + 1);
}

let refreshing: Promise<boolean> | null = null;

export function refreshSession(): Promise<boolean> {
  refreshing ??= fetch(`/${API_PREFIX}/auth/refresh`, {
    method: 'POST',
    credentials: 'same-origin',
  })
    .then((response) => response.ok)
    .catch(() => false)
    .finally(() => {
      refreshing = null;
    });
  return refreshing;
}

export interface ApiOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  /** false pour les routes publiques (connexion…) : pas de rafraîchissement automatique. */
  retryOnUnauthorized?: boolean;
}

export async function api<T = unknown>(
  path: string,
  options: ApiOptions = {},
): Promise<ApiResult<T>> {
  const method = options.method ?? 'GET';
  const send = () => {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (options.body !== undefined) headers['content-type'] = 'application/json';
    const csrf = readCookie(AUTH_COOKIES.csrf);
    if (method !== 'GET' && csrf) headers[CSRF_HEADER] = csrf;
    return fetch(`/${API_PREFIX}${path}`, {
      method,
      headers,
      credentials: 'same-origin',
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    });
  };

  let response: Response;
  try {
    response = await send();
    if (
      response.status === 401 &&
      options.retryOnUnauthorized !== false &&
      (await refreshSession())
    ) {
      response = await send();
    }
  } catch {
    return { ok: false, status: 0, problem: null };
  }

  // Corps vide possible (204, 202…) : on ne décode que s'il y a du contenu.
  const text = await response.text().catch(() => '');
  let parsed: unknown = undefined;
  try {
    parsed = text ? JSON.parse(text) : undefined;
  } catch {
    parsed = undefined;
  }
  if (response.ok) return { ok: true, status: response.status, data: parsed as T };
  return {
    ok: false,
    status: response.status,
    problem: (parsed as ProblemDetails | undefined) ?? null,
  };
}

/** Origine fictive servant uniquement à résoudre `next` comme le ferait le navigateur. */
const NEXT_BASE = 'https://ecsi.invalid';

/**
 * Navigation interne sûre après connexion : uniquement un chemin relatif du dashboard.
 * Le navigateur retire tabulations et retours à la ligne et lit « \\ » comme « / » :
 * `/\t/hote` ou `/\\hote` deviendraient `//hote` (autre site). On refuse donc tout caractère
 * de contrôle ou antislash, puis on vérifie que la résolution reste sur la même origine.
 */
export function safeNextPath(next: string | null | undefined): string {
  if (!next || !next.startsWith('/') || next.length > 2048) return '/';
  // eslint-disable-next-line no-control-regex -- refus volontaire des caractères de contrôle
  if (/[\u0000-\u001f\u007f\\]/.test(next)) return '/';
  let url: URL;
  try {
    url = new URL(next, NEXT_BASE);
  } catch {
    return '/';
  }
  if (url.origin !== NEXT_BASE || url.pathname.startsWith('//')) return '/';
  return `${url.pathname}${url.search}${url.hash}`;
}

/**
 * Navigation complète (rechargement) après un changement d'état d'authentification :
 * le serveur relit les nouveaux cookies et tout état client de l'ancienne session est effacé.
 */
export function hardNavigate(path: string): void {
  window.location.assign(path);
}
