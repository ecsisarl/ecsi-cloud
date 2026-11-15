import { fileURLToPath } from 'node:url';
import type { NextConfig } from 'next';
import createNextIntlPlugin from 'next-intl/plugin';

const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts');

/**
 * CSP du dashboard (build de production : `next build`, donc aussi l'image Docker).
 * Next.js insère des scripts en ligne (amorçage, flight data) : 'unsafe-inline' reste nécessaire
 * sans nonce par requête. La politique bloque néanmoins tout script, style, image, police ou
 * connexion venant d'une autre origine, les plugins, l'encadrement et les formulaires externes.
 * `pnpm dev` (HMR : eval + websocket) n'en reçoit pas.
 */
const contentSecurityPolicy = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

const securityHeaders = [
  ...(process.env.NODE_ENV === 'development'
    ? []
    : [{ key: 'Content-Security-Policy', value: contentSecurityPolicy }]),
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
];

const config: NextConfig = {
  output: 'standalone',
  // Monorepo : le traçage des fichiers du build autonome part de la racine du dépôt.
  outputFileTracingRoot: fileURLToPath(new URL('../../', import.meta.url)),
  transpilePackages: ['@ecsi/ui'],
  poweredByHeader: false,
  reactStrictMode: true,
  // Développement hors Docker (`pnpm dev`) : /api est relayé vers l'API (même origine pour
  // les cookies). En Docker et en production, Nginx route /api directement vers l'API.
  rewrites() {
    const api = process.env.API_INTERNAL_URL ?? 'http://localhost:4000';
    return Promise.resolve([{ source: '/api/:path*', destination: `${api}/api/:path*` }]);
  },
  headers() {
    return Promise.resolve([{ source: '/:path*', headers: securityHeaders }]);
  },
};

export default withNextIntl(config);
