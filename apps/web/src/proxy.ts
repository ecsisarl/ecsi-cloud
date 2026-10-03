import { API_PREFIX, AUTH_COOKIES } from '@ecsi/shared';
import { type NextRequest, NextResponse } from 'next/server';

/**
 * Garde de navigation du dashboard (exécutée avant le rendu) :
 *  - pages publiques (connexion, mot de passe oublié, invitation…) : accès libre ;
 *  - jeton d'accès présent : la page vérifie la session auprès de l'API (/auth/me) ;
 *  - jeton d'accès expiré mais refresh token présent : rotation côté serveur, les nouveaux
 *    cookies sont renvoyés au navigateur ET transmis au rendu de la page ;
 *  - sinon : redirection vers la page de connexion, avec retour à la page demandée.
 */
const PUBLIC_PATHS = [
  '/connexion',
  '/mot-de-passe-oublie',
  '/reinitialisation',
  '/invitation',
  '/plateforme/connexion',
];

function isPublic(pathname: string): boolean {
  return PUBLIC_PATHS.some((path) => pathname === path || pathname.startsWith(`${path}/`));
}

function loginUrl(request: NextRequest): URL {
  const platform = request.nextUrl.pathname.startsWith('/plateforme');
  const url = new URL(platform ? '/plateforme/connexion' : '/connexion', request.url);
  if (!platform && request.nextUrl.pathname !== '/') {
    url.searchParams.set('next', request.nextUrl.pathname);
  }
  return url;
}

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const forwarded = new Headers(request.headers);
  forwarded.set('x-ecsi-pathname', pathname);

  if (isPublic(pathname) || request.cookies.has(AUTH_COOKIES.access)) {
    return NextResponse.next({ request: { headers: forwarded } });
  }

  const refreshToken = request.cookies.get(AUTH_COOKIES.refresh)?.value;
  if (!refreshToken) return NextResponse.redirect(loginUrl(request));

  const clientIp = request.headers.get('x-forwarded-for')?.split(',').pop()?.trim();
  let refreshed: Response;
  try {
    refreshed = await fetch(
      `${process.env.API_INTERNAL_URL ?? 'http://localhost:4000'}/${API_PREFIX}/auth/refresh`,
      {
        method: 'POST',
        headers: {
          cookie: `${AUTH_COOKIES.refresh}=${refreshToken}`,
          ...(clientIp ? { 'x-forwarded-for': clientIp } : {}),
        },
        cache: 'no-store',
        signal: AbortSignal.timeout(5_000),
      },
    );
  } catch {
    return NextResponse.redirect(loginUrl(request));
  }
  if (!refreshed.ok) {
    const response = NextResponse.redirect(loginUrl(request));
    for (const name of [AUTH_COOKIES.access, AUTH_COOKIES.refresh, AUTH_COOKIES.csrf]) {
      response.cookies.delete(name);
    }
    return response;
  }

  // Les nouveaux cookies sont visibles par le rendu de cette requête…
  const setCookies = refreshed.headers.getSetCookie();
  const renewed = new Map(request.cookies.getAll().map((c) => [c.name, c.value]));
  for (const line of setCookies) {
    const [pair] = line.split(';');
    const index = pair?.indexOf('=') ?? -1;
    if (pair && index > 0) renewed.set(pair.slice(0, index), pair.slice(index + 1));
  }
  forwarded.set('cookie', [...renewed].map(([name, value]) => `${name}=${value}`).join('; '));
  const response = NextResponse.next({ request: { headers: forwarded } });
  // … et renvoyés au navigateur tels que l'API les a émis (httpOnly, SameSite=Strict).
  for (const line of setCookies) response.headers.append('set-cookie', line);
  return response;
}

export const config = {
  matcher: ['/((?!api/|_next/|favicon.ico|.*\\.(?:svg|png|ico|webp|jpg|css|js)$).*)'],
};
