import { defineConfig } from 'drizzle-kit';
import 'dotenv/config';

export default defineConfig({
  schema: './src/db/schema.ts',
  out: './src/db/turso_migrations',
  dialect: 'turso',
  dbCredentials: { url: process.env.TURSO_DATABASE_URL ?? 'file:local.db', authToken: process.env.TURSO_AUTH_TOKEN },
});
