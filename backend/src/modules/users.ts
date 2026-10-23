import { Router } from 'express';
import { z } from 'zod';
import { desc, eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db } from '../db/index.js';
import { users, wallets, walletTransactions, auditLogs, userTiers } from '../db/schema.js';
import { sqlClient } from '../db/sql.js';
import { AppError, parse, requireAdmin, requireUser, amountSchema } from '../lib/core.js';

export const adminUserRouter = Router();

adminUserRouter.use(requireUser, requireAdmin);

// Lấy danh sách người dùng kèm số dư ví, loại tài khoản và thống kê số đơn
adminUserRouter.get('/', async (_req, res) => {
  const result = await sqlClient.query(`
    SELECT 
      u.id,
      u.email,
      u.name,
      u.role,
      u.tier_id AS "tierId",
      u.status,
      u.created_at AS "createdAt",
      COALESCE(w.balance_amount, 0) AS balance,
      COALESCE(ut.name, CASE WHEN u.role = 'admin' THEN 'Quản trị viên' ELSE 'Thành viên' END) AS "tierName",
      COALESCE(ut.code, CASE WHEN u.role = 'admin' THEN 'admin' ELSE 'thanh_vien' END) AS "tierCode",
      COALESCE(ut.discount_percent, CASE WHEN u.role = 'admin' THEN 100 ELSE 0 END) AS "tierDiscount",
      COUNT(DISTINCT o.id) AS "totalOrders",
      COUNT(DISTINCT CASE WHEN o.status = 'completed' THEN o.id END) AS "completedOrders",
      COUNT(DISTINCT CASE WHEN o.status IN ('queued', 'sending', 'processing') THEN o.id END) AS "processingOrders",
      COALESCE(SUM(CASE WHEN o.status = 'completed' THEN o.total_amount ELSE 0 END), 0) AS "totalSpent",
      COALESCE((
        SELECT SUM(oi.quantity)
        FROM orders o2
        JOIN order_items oi ON oi.order_id = o2.id
        WHERE o2.user_id = u.id
      ), 0) AS "totalCodes"
    FROM users u
    LEFT JOIN wallets w ON w.user_id = u.id
    LEFT JOIN user_tiers ut ON ut.id = u.tier_id
    LEFT JOIN orders o ON o.user_id = u.id
    GROUP BY u.id
    ORDER BY u.created_at DESC
    LIMIT 10000
  `);

  const list = result.rows.map(row => ({
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    tierId: row.tierId,
    tierName: row.tierName,
    tierCode: row.tierCode,
    tierDiscount: Number(row.tierDiscount) || 0,
    status: row.status,
    createdAt: row.createdAt,
    balance: Number(row.balance) || 0,
    totalOrders: Number(row.totalOrders) || 0,
    totalCodes: Number(row.totalCodes) || 0,
    completedOrders: Number(row.completedOrders) || 0,
    processingOrders: Number(row.processingOrders) || 0,
    totalSpent: Number(row.totalSpent) || 0,
  }));

  res.json(list);
});

// Lấy danh sách toàn bộ đơn hàng và code sự kiện của 1 tài khoản cụ thể
adminUserRouter.get('/:id/orders', async (req, res) => {
  const userId = String(req.params.id);
  const result = await sqlClient.query(`
    SELECT o.*,
      COALESCE(
        json_group_array(
          json_object(
            'id', oi.id,
            'productId', oi.product_id,
            'productName', oi.product_name,
            'unitPrice', oi.unit_price,
            'quantity', oi.quantity,
            'totalAmount', oi.total_amount,
            'customerInput', json(oi.customer_input)
          )
        ), '[]'
      ) AS items
    FROM orders o
    LEFT JOIN order_items oi ON oi.order_id = o.id
    WHERE o.user_id = $1
    GROUP BY o.id
    ORDER BY o.created_at DESC
    LIMIT 10000
  `, [userId]);

  const list = result.rows.map(row => {
    let items = [];
    try {
      items = typeof row.items === 'string' ? JSON.parse(row.items) : row.items;
      if (Array.isArray(items) && items.length === 1 && !items[0].id) {
        items = [];
      }
    } catch {
      items = [];
    }
    return { ...row, items };
  });

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

// Cập nhật trạng thái (active / blocked), phân quyền (customer / admin), hoặc loại người dùng (tierId)
const updateUserSchema = z.object({
  status: z.enum(['active', 'blocked']).optional(),
  role: z.enum(['customer', 'admin']).optional(),
  tierId: z.string().optional(),
  name: z.string().trim().min(1).max(120).optional(),
});

adminUserRouter.patch('/:id', async (req, res) => {
  const input = parse(updateUserSchema, req.body);
  const userId = String(req.params.id);

  // Không cho admin tự block chính mình
  if (req.user?.id === userId && input.status === 'blocked') {
    throw new AppError(400, 'BAD_REQUEST', 'Không thể tự khóa tài khoản của chính mình');
  }

  // Tự động đồng bộ tier nếu thăng admin
  if (input.role === 'admin' && !input.tierId) {
    input.tierId = 'tier_admin';
  } else if (input.role === 'customer' && !input.tierId) {
    input.tierId = 'tier_member';
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
