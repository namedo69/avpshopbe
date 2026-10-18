import type { Transaction } from '@libsql/client';
import { client } from './index.js';

type Value = string | number | boolean | Date | null | undefined;
type Row = Record<string, any>;

function statement(source: string, values: Value[]) {
  const args: (string | number | null)[] = [];
  const sql = source.replace(/\$(\d+)/g, (_match, position: string) => {
    const value = values[Number(position) - 1];
    args.push(value instanceof Date ? value.getTime() : typeof value === 'boolean' ? Number(value) : value ?? null);
    return '?';
  });
  return { sql, args };
}

async function execute<T extends Row>(target: { execute: Transaction['execute'] }, source: string, values: Value[] = []) {
  const result = await target.execute(statement(source, values));
  return { rows: result.rows as unknown as T[] };
}

export const sqlClient = {
  query: <T extends Row = Row>(source: string, values: Value[] = []) => execute<T>(client, source, values),
  async connect() {
    const tx = await client.transaction('write');
    let closed = false;
    return {
      async query<T extends Row = Row>(source: string, values: Value[] = []) {
        if (source === 'BEGIN') return { rows: [] as T[] };
        if (source === 'COMMIT') { if (!closed) { await tx.commit(); closed = true; } return { rows: [] as T[] }; }
        if (source === 'ROLLBACK') { if (!closed) { await tx.rollback(); closed = true; } return { rows: [] as T[] }; }
        return execute<T>(tx, source, values);
      },
      release() { tx.close(); },
    };
  },
};
