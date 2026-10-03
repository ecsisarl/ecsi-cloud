import { fileURLToPath } from 'node:url';
import type { NextConfig } from 'next';
import createNextIntlPlugin from 'next-intl/plugin';

const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts');

const securityHeaders = [
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
