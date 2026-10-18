import { Router } from 'express';
import { z } from 'zod';
import { desc, eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db } from '../db/index.js';
import { users, wallets, walletTransactions, auditLogs } from '../db/schema.js';
import { AppError, parse, requireAdmin, requireUser, amountSchema } from '../lib/core.js';

export const adminUserRouter = Router();

adminUserRouter.use(requireUser, requireAdmin);

// Lấy danh sách người dùng kèm số dư ví
adminUserRouter.get('/', async (_req, res) => {
  const list = await db
    .select({
      id: users.id,
      email: users.email,
      name: users.name,
      role: users.role,
      status: users.status,
      createdAt: users.createdAt,
      balance: wallets.balanceAmount,
    })
    .from(users)
    .leftJoin(wallets, eq(users.id, wallets.userId))
    .orderBy(desc(users.createdAt))
    .limit(200);

  res.json(list);
});

// Điều chỉnh số dư ví (Cộng hoặc Trừ tiền có ghi sổ giao dịch đối soát)
const adjustBalanceSchema = z.object({
  amount: z.number().int().safe(), // Số dương = cộng, số âm = trừ
  reason: z.string().trim().min(1).max(255),
});

adminUserRouter.post('/:id/balance', async (req, res) => {
  const { amount, reason } = parse(adjustBalanceSchema, req.body);
  const userId = String(req.params.id);

  if (amount === 0) {
    throw new AppError(400, 'BAD_REQUEST', 'Số tiền điều chỉnh không được bằng 0');
  }

  const result = await db.transaction(async (tx) => {
    // 1. Kiểm tra user
    const [user] = await tx.select().from(users).where(eq(users.id, userId));
    if (!user) throw new AppError(404, 'NOT_FOUND', 'Không tìm thấy người dùng');

    // 2. Lấy hoặc khởi tạo ví
    let [wallet] = await tx.select().from(wallets).where(eq(wallets.userId, userId));
    if (!wallet) {
      [wallet] = await tx.insert(wallets).values({ userId, balanceAmount: 0 }).returning();
    }

    const currentBalance = wallet!.balanceAmount ?? 0;
    const newBalance = currentBalance + amount;

    if (newBalance < 0) {
      throw new AppError(400, 'INSUFFICIENT_BALANCE', 'Số dư ví sau khi trừ không thể âm');
    }

    // 3. Cập nhật số dư ví
    await tx
      .update(wallets)
      .set({
        balanceAmount: newBalance,
        version: sql`${wallets.version} + 1`,
      })
      .where(eq(wallets.userId, userId));

    // 4. Ghi sổ giao dịch (wallet_transactions) để minh bạch đối soát
    const referenceId = `ADJ_${Date.now()}_${randomUUID().substring(0, 8)}`;
    await tx.insert(walletTransactions).values({
      userId,
      type: 'adjustment',
      amount,
      balanceBefore: currentBalance,
      balanceAfter: newBalance,
      referenceType: 'admin_adjustment',
      referenceId,
      status: 'completed',
      description: `Admin điều chỉnh: ${reason}`,
      metadata: { adminId: req.user!.id, reason },
    });

    // 5. Ghi nhật ký hệ thống (audit_logs)
    await tx.insert(auditLogs).values({
      actorId: req.user!.id,
      action: amount > 0 ? 'user.balance.credit' : 'user.balance.debit',
      targetType: 'user',
      targetId: userId,
      metadata: { amount, reason, balanceBefore: currentBalance, balanceAfter: newBalance },
    });

    return {
      userId,
      balance: newBalance,
      amountAdjusted: amount,
    };
  });

  res.json(result);
});

// Cập nhật trạng thái (active / blocked) hoặc phân quyền (customer / admin)
const updateUserSchema = z.object({
  status: z.enum(['active', 'blocked']).optional(),
  role: z.enum(['customer', 'admin']).optional(),
  name: z.string().trim().min(1).max(120).optional(),
});

adminUserRouter.patch('/:id', async (req, res) => {
  const input = parse(updateUserSchema, req.body);
  const userId = String(req.params.id);

  // Không cho admin tự block chính mình
  if (req.user?.id === userId && input.status === 'blocked') {
    throw new AppError(400, 'BAD_REQUEST', 'Không thể tự khóa tài khoản của chính mình');
  }

  const [updatedUser] = await db
    .update(users)
    .set({ ...input, updatedAt: new Date() })
    .where(eq(users.id, userId))
    .returning();

  if (!updatedUser) {
    throw new AppError(404, 'NOT_FOUND', 'Không tìm thấy người dùng');
  }

  await db.insert(auditLogs).values({
    actorId: req.user!.id,
    action: 'user.update',
    targetType: 'user',
    targetId: updatedUser.id,
    metadata: input,
  });

  res.json(updatedUser);
});
