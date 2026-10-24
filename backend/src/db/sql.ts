import { pool } from './index.js';

type Value = string | number | boolean | Date | null | undefined;
type Row = Record<string, any>;

export const sqlClient = {
  async query<T extends Row = Row>(source: string, values: Value[] = []) {
    const args = values.map(v => v instanceof Date ? v.toISOString() : v ?? null);
    const result = await pool.query(source, args);
    return { rows: result.rows as T[] };
  },
  async connect() {
    const client = await pool.connect();
    return {
      async query<T extends Row = Row>(source: string, values: Value[] = []) {
        const args = values.map(v => v instanceof Date ? v.toISOString() : v ?? null);
        const result = await client.query(source, args);
        return { rows: result.rows as T[] };
      },
      release() { client.release(); },
    };
  },
};
