import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createHmac, randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';

describe('libSQL money concurrency', () => {
  let app: typeof import('../src/app.js').app;
  let client: typeof import('../src/db/index.js').client;
  let sqlClient: typeof import('../src/db/sql.js').sqlClient;
  let accessToken: typeof import('../src/lib/core.js').accessToken;
  let tempDirectory: string | undefined;
  let bankId: string;
  beforeAll(async () => {
    if (process.env.TEST_TURSO_DATABASE_URL) {
      process.env.TURSO_DATABASE_URL = process.env.TEST_TURSO_DATABASE_URL;
      process.env.TURSO_AUTH_TOKEN = process.env.TEST_TURSO_AUTH_TOKEN;
    } else {
      tempDirectory = await mkdtemp(join(tmpdir(), 'csuc-turso-test-'));
      process.env.TURSO_DATABASE_URL = `file:${join(tempDirectory, 'test.db').replaceAll('\\', '/')}`;
      delete process.env.TURSO_AUTH_TOKEN;
    }
    process.env.JWT_ACCESS_SECRET = 'test-access-secret-32-characters-long';
    process.env.SEPAY_WEBHOOK_SECRET = 'test-sepay-secret-32-characters-long';
    ({ app } = await import('../src/app.js'));
    ({ client } = await import('../src/db/index.js'));
    ({ sqlClient } = await import('../src/db/sql.js'));
    ({ accessToken } = await import('../src/lib/core.js'));
    const { migrate } = await import('drizzle-orm/libsql/migrator');
    const { db } = await import('../src/db/index.js');
    await migrate(db, { migrationsFolder: './src/db/turso_migrations' });
    bankId = String((await sqlClient.query("INSERT INTO bank_accounts(bank_code,account_number,account_name) VALUES('VCB',$1,'TEST') RETURNING id", [`T${randomUUID().replaceAll('-', '')}`])).rows[0]?.id);
  });
  afterAll(async () => {
    if (client) client.close();
    if (tempDirectory) {
      const target = await realpath(tempDirectory);
      const base = await realpath(tmpdir());
      if (!target.startsWith(resolve(base) + sep)) throw new Error('Unsafe test cleanup path');
      try { await rm(target, { recursive: true, force: true }); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EBUSY') throw error;
        // The libSQL native Windows handle is released when the test process exits.
      }
    }
  });
  async function customer(balance: number) {
    const id = randomUUID();
    await sqlClient.query("INSERT INTO users(id,email,password_hash,name) VALUES($1,$2,'unused','Test')", [id, `${id}@example.invalid`]);
    await sqlClient.query('INSERT INTO wallets(user_id,balance_amount) VALUES($1,$2)', [id, balance]);
    return { id, token: await accessToken(id, 'customer') };
  }
  it('credits a repeated SePay transaction once', async () => {
    const user = await customer(0);
    const created = await request(app).post('/api/v1/deposits').set('authorization', `Bearer ${user.token}`).send({ amount: 10000 });
    expect(created.status).toBe(201);
    const code = created.body.paymentCode as string;
    const account = (await sqlClient.query('SELECT account_number FROM bank_accounts WHERE id=$1', [bankId])).rows[0]?.account_number;
    const body = { id: Math.floor(Math.random() * 1_000_000_000), accountNumber: account, code, content: code, transferType: 'in', transferAmount: 10000 };
    const raw = JSON.stringify(body);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = 'sha256=' + createHmac('sha256', process.env.SEPAY_WEBHOOK_SECRET!).update(`${timestamp}.${raw}`).digest('hex');
    const send = () => request(app).post('/api/v1/webhooks/sepay').set('content-type', 'application/json').set('x-sepay-timestamp', timestamp).set('x-sepay-signature', signature).send(raw);
    const responses = await Promise.all([send(), send()]);
    expect(responses.map(r => r.status)).toEqual([200, 200]);
    const wallet = await sqlClient.query('SELECT balance_amount FROM wallets WHERE user_id=$1', [user.id]);
    expect(wallet.rows[0]?.balance_amount).toBe(10000);
    const ledger = await sqlClient.query("SELECT count(*) AS n FROM wallet_transactions WHERE user_id=$1 AND type='deposit'", [user.id]);
    expect(ledger.rows[0]?.n).toBe(1);
  });
  it('does not spend the same balance twice', async () => {
    const user = await customer(10000);
    const product = (await sqlClient.query("INSERT INTO products(name,slug,price_amount,min_quantity,max_quantity) VALUES('Test',$1,10000,1,1) RETURNING id", [`test-${randomUUID()}`])).rows[0];
    const provider = (await sqlClient.query("INSERT INTO providers(code,name,base_url) VALUES($1,'Test','https://example.invalid') RETURNING id", [`test-${randomUUID()}`])).rows[0];
    await sqlClient.query("INSERT INTO provider_products(product_id,provider_id,external_service_id,cost_amount) VALUES($1,$2,'service',1000)", [product?.id, provider?.id]);
    const send = () => request(app).post('/api/v1/orders').set('authorization', `Bearer ${user.token}`).set('idempotency-key', randomUUID()).send({ items: [{ productId: product?.id, quantity: 1, customerInput: {} }] });
    const responses = await Promise.all([send(), send()]);
    expect(responses.map(r => r.status).sort()).toEqual([201, 409]);
    const wallet = await sqlClient.query('SELECT balance_amount FROM wallets WHERE user_id=$1', [user.id]);
    expect(wallet.rows[0]?.balance_amount).toBe(0);
    const orders = await sqlClient.query('SELECT count(*) AS n FROM orders WHERE user_id=$1', [user.id]);
    expect(orders.rows[0]?.n).toBe(1);
    const [order] = (await sqlClient.query('SELECT id FROM orders WHERE user_id=$1', [user.id])).rows;
    const admin = await customer(0);
    await sqlClient.query("UPDATE users SET role='admin' WHERE id=$1", [admin.id]);
    const adminToken = await accessToken(admin.id, 'admin');
    const failed = await request(app).patch(`/api/v1/admin/orders/${order?.id}/status`).set('authorization', `Bearer ${adminToken}`).send({ status: 'failed', reason: 'Provider rejected the order' });
    expect(failed.status).toBe(200);
    const refund = () => request(app).post(`/api/v1/admin/orders/${order?.id}/refund`).set('authorization', `Bearer ${adminToken}`).send({ reason: 'Provider rejected the order' });
    const refunds = await Promise.all([refund(), refund()]);
    expect(refunds.map(r => r.status).sort()).toEqual([200, 409]);
    const restored = await sqlClient.query('SELECT balance_amount FROM wallets WHERE user_id=$1', [user.id]);
    expect(restored.rows[0]?.balance_amount).toBe(10000);
  });
});
