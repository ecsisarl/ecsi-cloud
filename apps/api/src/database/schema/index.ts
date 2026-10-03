/**
 * Schéma Drizzle de l'application (conventions : docs/DATABASE.md).
 * Les politiques RLS et les privilèges sont dans les migrations SQL écrites à la main.
 */
export * from './identity.js';
export * from './tenancy.js';
