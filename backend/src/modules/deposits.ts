import { Router } from 'express';
import { z } from 'zod';
import { desc, eq, and } from 'drizzle-orm';
import { db } from '../db/index.js';
import { bankAccounts, deposits, paymentWebhookEvents } from '../db/schema.js';
import { sqlClient } from '../db/sql.js';
import { AppError, amountSchema, code, env, parse, requireAdmin, requireUser, verifySepay } from '../lib/core.js';

export const depositRouter = Router();
export const webhookRouter = Router();
export const adminDepositRouter = Router();
const webhookSchema = z.object({ id: z.union([z.number().int(), z.string()]), accountNumber: z.string(), code: z.string().nullable().optional(), content: z.string(), transferType: z.string(), transferAmount: amountSchema });

export function paymentCode(payload: { code?: string | null; content: string }, prefix = env.paymentPrefix) {
  const re = new RegExp(`${prefix}[A-F0-9]{16}`, 'i');
  return (payload.code?.match(re)?.[0] ?? payload.content.match(re)?.[0] ?? '').toUpperCase();
}

depositRouter.use(requireUser);
depositRouter.post('/', async (req, res) => {
  const { amount } = parse(z.object({ amount: amountSchema.min(10_000).max(100_000_000) }), req.body);
  const [bank] = await db.select().from(bankAccounts).where(eq(bankAccounts.isActive, true)).limit(1);
  if (!bank) throw new AppError(503, 'BANK_NOT_CONFIGURED', 'Chưa cấu hình tài khoản nhận tiền');
  const [deposit] = await db.insert(deposits).values({ userId: req.user!.id, amount, bankAccountId: bank.id, paymentCode: code(env.paymentPrefix), expiresAt: new Date(Date.now() + 30 * 60_000) }).returning();
  const qr = new URL(`https://vietqr.app/img`);
  qr.searchParams.set('acc', bank.accountNumber); qr.searchParams.set('bank', bank.bankCode); qr.searchParams.set('amount', String(amount)); qr.searchParams.set('des', deposit!.paymentCode);
  res.status(201).json({ ...deposit, bank: { bankCode: bank.bankCode, accountNumber: bank.accountNumber, accountName: bank.accountName }, qrUrl: qr.toString() });
});

depositRouter.get('/', async (req, res) => res.json(await db.select().from(deposits).where(eq(deposits.userId, req.user!.id)).orderBy(desc(deposits.createdAt)).limit(100)));
depositRouter.get('/:paymentCode', async (req, res) => {
  const [row] = await db.select().from(deposits).where(and(eq(deposits.userId, req.user!.id), eq(deposits.paymentCode, String(req.params.paymentCode))));
  if (!row) throw new AppError(404, 'NOT_FOUND', 'Không tìm thấy yêu cầu nạp');
  res.json(row);
});

async function creditDeposit(depositId: string, reference: string, eventId?: string, payload?: unknown, allowExpired = false) {
  const client = await sqlClient.connect();
  try {
    await client.query('BEGIN');
    if (eventId) {
      const inserted = await client.query("INSERT INTO payment_webhook_events(provider,event_id,payload,status,deposit_id) VALUES('sepay',$1,$2,'received',$3) ON CONFLICT(provider,event_id) DO NOTHING RETURNING id", [eventId, JSON.stringify(payload), depositId]);
      if (!inserted.rows[0]) { await client.query('ROLLBACK'); return false; }
    }
    const claim = await client.query<{ id: string; user_id: string; amount: number }>("UPDATE deposits SET status='completed', completed_at=(unixepoch()*1000), sepay_transaction_id=$2 WHERE id=$1 AND (status='pending' OR ($3 AND status='expired')) AND ($3 OR expires_at>(unixepoch()*1000)) RETURNING id,user_id,amount", [depositId, eventId ?? null, allowExpired]);
    const row = claim.rows[0];
    if (!row) {
      if (eventId) { await client.query("UPDATE payment_webhook_events SET status='ignored',error_message='Deposit no longer pending',processed_at=(unixepoch()*1000) WHERE provider='sepay' AND event_id=$1", [eventId]); await client.query('COMMIT'); }
      else await client.query('ROLLBACK');
      return false;
    }
    const balance = await client.query<{ balance_before: number; balance_after: number }>('UPDATE wallets SET balance_amount=balance_amount+$2, version=version+1 WHERE user_id=$1 RETURNING balance_amount-$2 AS balance_before,balance_amount AS balance_after', [row.user_id, row.amount]);
    if (!balance.rows[0]) throw new Error('Wallet missing');
    await client.query("INSERT INTO wallet_transactions(user_id,type,amount,balance_before,balance_after,reference_type,reference_id,status) VALUES($1,'deposit',$2,$3,$4,'deposit',$5,'completed')", [row.user_id, row.amount, balance.rows[0].balance_before, balance.rows[0].balance_after, reference]);
    if (eventId) await client.query("UPDATE payment_webhook_events SET status='processed',processed_at=(unixepoch()*1000) WHERE provider='sepay' AND event_id=$1", [eventId]);
    await client.query('COMMIT'); return true;
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}

webhookRouter.post('/sepay', async (req, res) => {
  if (!Buffer.isBuffer(req.body) || !verifySepay(req.body, req.header('x-sepay-signature') ?? '', req.header('x-sepay-timestamp') ?? '')) throw new AppError(401, 'INVALID_SIGNATURE', 'Chữ ký SePay không hợp lệ');
  const raw = JSON.parse(req.body.toString('utf8')) as unknown;
  const data = parse(webhookSchema, raw);
  const eventId = String(data.id);
  const matchedCode = paymentCode(data);
  const [deposit] = matchedCode ? await db.select().from(deposits).where(eq(deposits.paymentCode, matchedCode)) : [];
  const [bank] = deposit ? await db.select().from(bankAccounts).where(eq(bankAccounts.id, deposit.bankAccountId)) : [];
  const valid = data.transferType === 'in' && deposit && bank && bank.accountNumber === data.accountNumber && deposit.amount === data.transferAmount;
  if (!valid) {
    await db.insert(paymentWebhookEvents).values({ provider: 'sepay', eventId, payload: raw, status: 'ignored', errorMessage: 'Unmatched payment, amount or account', processedAt: new Date() }).onConflictDoNothing();
    res.json({ success: true }); return;
  }
  await creditDeposit(deposit.id, deposit.id, eventId, raw);
  res.json({ success: true });
});

// Admin Bank Accounts & Deposits Management
adminDepositRouter.use(requireUser, requireAdmin);

// Lấy thông tin tài khoản ngân hàng nhận tiền
adminDepositRouter.get('/bank-account', async (_req, res) => {
  const [bank] = await db.select().from(bankAccounts).limit(1);
  res.json(bank ?? null);
});

// Cập nhật hoặc thêm tài khoản ngân hàng nhận tiền
const bankAccountSchema = z.object({
  bankCode: z.string().trim().min(2).max(20).toUpperCase(),
  accountNumber: z.string().trim().min(4).max(50),
  accountName: z.string().trim().min(2).max(100).toUpperCase(),
});

adminDepositRouter.post('/bank-account', async (req, res) => {
  const input = parse(bankAccountSchema, req.body);
  const [existing] = await db.select().from(bankAccounts).limit(1);

  if (existing) {
    const [updated] = await db
      .update(bankAccounts)
      .set({ ...input, isActive: true })
      .where(eq(bankAccounts.id, existing.id))
      .returning();
    res.json(updated);
  } else {
    const [created] = await db
      .insert(bankAccounts)
      .values({ ...input, isActive: true })
      .returning();
    res.status(201).json(created);
  }
});

adminDepositRouter.get('/', async (_req, res) => res.json(await db.select().from(deposits).orderBy(desc(deposits.createdAt)).limit(100)));

adminDepositRouter.post('/:id/approve', async (req, res) => {
  const { reason } = parse(z.object({ reason: z.string().trim().min(5).max(500) }), req.body);
  const approved = await creditDeposit(String(req.params.id), String(req.params.id), undefined, undefined, true);
  if (!approved) throw new AppError(409, 'NOT_PENDING', 'Yêu cầu nạp không còn hợp lệ');
  res.json({ approved: true });
});
