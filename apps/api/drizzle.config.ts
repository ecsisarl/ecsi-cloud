import { defineConfig } from 'drizzle-kit';

// Utilisé uniquement par `pnpm db:generate` (génération des migrations SQL).
// L'application des migrations se fait par `pnpm db:migrate` (src/database/migrate.ts).
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/database/schema/index.ts',
  out: './src/database/migrations',
  casing: 'snake_case',
});
