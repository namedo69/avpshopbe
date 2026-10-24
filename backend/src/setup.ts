import 'dotenv/config';
import argon2 from 'argon2';
import { eq } from 'drizzle-orm';
import { db, pool } from './db/index.js';
import { bankAccounts, providers, users, wallets } from './db/schema.js';

async function main() {
  const email = process.env.SETUP_ADMIN_EMAIL?.toLowerCase();
  const password = process.env.SETUP_ADMIN_PASSWORD;
  if (!email || !password || password.length < 12) throw new Error('SETUP_ADMIN_EMAIL and a 12+ character SETUP_ADMIN_PASSWORD are required');
  const hash = await argon2.hash(password, { type: argon2.argon2id });
  await db.transaction(async tx => {
    const [existing] = await tx.select().from(users).where(eq(users.email, email));
    if (existing) throw new Error('Admin email already exists; refusing to elevate an existing account');
    const [admin] = await tx.insert(users).values({ email, passwordHash: hash, name: 'Administrator', role: 'admin' }).returning();
    await tx.insert(wallets).values({ userId: admin!.id, balanceAmount: 0 });
  });
  if (process.env.SEPAY_BANK_ACCOUNT_NUMBER && process.env.SEPAY_BANK_CODE && process.env.SEPAY_BANK_ACCOUNT_NAME) {
    await db.insert(bankAccounts).values({ accountNumber: process.env.SEPAY_BANK_ACCOUNT_NUMBER, bankCode: process.env.SEPAY_BANK_CODE, accountName: process.env.SEPAY_BANK_ACCOUNT_NAME }).onConflictDoNothing();
  }
  if (process.env.PMOD_BASE_URL) await db.insert(providers).values({ code: 'pmod', name: 'PMOD', baseUrl: process.env.PMOD_BASE_URL }).onConflictDoNothing();
  process.stdout.write('Initial setup complete\n');
}
main().catch(error => { process.stderr.write(String(error) + '\n'); process.exitCode = 1; }).finally(() => pool.end());
