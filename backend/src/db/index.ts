import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import * as schema from './schema.js';

if (process.env.NODE_ENV === 'production' && (!process.env.TURSO_DATABASE_URL || !process.env.TURSO_AUTH_TOKEN)) {
  throw new Error('TURSO_DATABASE_URL and TURSO_AUTH_TOKEN are required in production');
}
export const client = createClient({ url: process.env.TURSO_DATABASE_URL ?? 'file:local.db', authToken: process.env.TURSO_AUTH_TOKEN });
export const db = drizzle({ client, schema });
