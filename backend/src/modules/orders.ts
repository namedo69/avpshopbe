import { Router } from 'express';
import { z } from 'zod';
import { desc, eq, and, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { orders, orderItems, orderStatusLogs, providerOrders, vouchers, voucherProducts, voucherUsages, walletTransactions, wallets, products, auditLogs } from '../db/schema.js';
import { sqlClient } from '../db/sql.js';
import { AppError, amountSchema, calcDiscount, code, parse, requireAdmin, requireUser, sha256 } from '../lib/core.js';

export const orderRouter = Router();
export const adminOrderRouter = Router();
export const walletRouter = Router();

const checkoutItemSchema = z.object({
  productId: z.uuid(),
  quantity: z.number().int().positive().max(10000).default(1),
  customerInput: z.record(z.string(), z.unknown()).default({}),
});

const checkoutSchema = z.object({
  items: z.array(checkoutItemSchema).min(1).max(100),
  voucherCode: z.string().optional(),
  customerNote: z.string().max(1000).optional(),
  splitOrders: z.boolean().default(false),
});

walletRouter.use(requireUser);
walletRouter.get('/', async (req, res) => {
  const [row] = await db.select().from(wallets).where(eq(wallets.userId, req.user!.id));
  res.json(row ?? { userId: req.user!.id, balanceAmount: 0 });
});

walletRouter.get('/transactions', async (req, res) =>
  res.json(await db.select().from(walletTransactions).where(eq(walletTransactions.userId, req.user!.id)).orderBy(desc(walletTransactions.createdAt)).limit(100))
);

orderRouter.use(requireUser);

orderRouter.post('/', async (req, res) => {
  const input = parse(checkoutSchema, req.body);
  const key = req.header('idempotency-key');
  if (!key || key.length < 8 || key.length > 100) throw new AppError(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Cần Idempotency-Key từ 8 đến 100 ký tự');
  const requestHash = sha256(JSON.stringify(input));
  const client = await sqlClient.connect();

  try {
    await client.query('BEGIN');

    // 1. Kiểm tra Idempotency
    const existing = await client.query('SELECT * FROM orders WHERE user_id=$1 AND idempotency_key=$2', [req.user!.id, key]);
    if (existing.rows[0]) {
      if (existing.rows[0].request_hash !== requestHash) throw new AppError(409, 'IDEMPOTENCY_CONFLICT', 'Idempotency-Key đã được dùng cho yêu cầu khác');
      await client.query('COMMIT');
      res.json(existing.rows[0]);
      return;
    }

    // 2. Kiểm tra tài khoản user và thông tin loại người dùng (tier)
    const userRes = await client.query(`
      SELECT u.status, u.role, u.tier_id,
        COALESCE(ut.discount_percent, CASE WHEN u.role = 'admin' THEN 100 ELSE 0 END) AS tier_discount
      FROM users u
      LEFT JOIN user_tiers ut ON ut.id = u.tier_id
      WHERE u.id = $1
    `, [req.user!.id]);
    const user = userRes.rows[0];
    if (user?.status !== 'active') throw new AppError(403, 'ACCOUNT_BLOCKED', 'Tài khoản không hoạt động');

    const tierDiscountPercent = user.role === 'admin' ? 100 : (Number(user.tier_discount) || 0);

    let subtotal = 0;
    const lines: { productId: string; name: string; quantity: number; unitPrice: number; total: number; customerInput: Record<string, unknown> }[] = [];
    let hasAnyProvider = false;

    for (const item of input.items) {
      const result = await client.query('SELECT * FROM products WHERE id=$1 AND is_active=true', [item.productId]);
      const product = result.rows[0];
      if (!product) throw new AppError(400, 'INVALID_PRODUCT', 'Sản phẩm không khả dụng');

      const mapping = await client.query('SELECT 1 FROM provider_products pp JOIN providers p ON p.id=pp.provider_id WHERE pp.product_id=$1 AND pp.is_active=true AND p.is_active=true LIMIT 1', [item.productId]);
      if (mapping.rows[0]) hasAnyProvider = true;

      const schema = product.input_schema ?? {};
      if (Array.isArray(schema.required)) {
        for (const field of schema.required) {
          if (typeof field === 'string' && !item.customerInput[field]) throw new AppError(400, 'INVALID_CUSTOMER_INPUT', `Thiếu ${field}`);
        }
      }

      const basePrice = Number(product.sale_price_amount ?? product.price_amount);
      let effectiveUnitPrice = basePrice;

      if (user.role === 'admin' || tierDiscountPercent >= 100) {
        effectiveUnitPrice = 0;
      } else {
        const customTier = await client.query(
          'SELECT custom_price_amount FROM tier_product_prices WHERE tier_id=$1 AND product_id=$2',
          [user.tier_id, item.productId]
        );
        if (customTier.rows[0]?.custom_price_amount !== null && customTier.rows[0]?.custom_price_amount !== undefined) {
          effectiveUnitPrice = Number(customTier.rows[0].custom_price_amount);
        } else if (tierDiscountPercent > 0) {
          effectiveUnitPrice = Math.max(0, Math.round(basePrice * (100 - tierDiscountPercent) / 100));
        }
      }

      const total = effectiveUnitPrice * item.quantity;
      if (!Number.isSafeInteger(total)) throw new AppError(400, 'AMOUNT_OVERFLOW', 'Tổng tiền quá lớn');

      subtotal += total;
      lines.push({
        productId: item.productId,
        name: product.name,
        quantity: item.quantity,
        unitPrice: effectiveUnitPrice,
        total,
        customerInput: item.customerInput,
      });
    }

    if (!Number.isSafeInteger(subtotal) || subtotal > 1_000_000_000_000) throw new AppError(400, 'AMOUNT_OVERFLOW', 'Tổng tiền quá lớn');

    // 3. Tính toán Voucher
    let voucherId: string | null = null;
    let totalDiscount = 0;

    if (input.voucherCode) {
      const result = await client.query('SELECT * FROM vouchers WHERE code=$1', [input.voucherCode.toUpperCase()]);
      const v = result.rows[0];
      const now = Date.now();

      if (!v || !v.is_active || (v.starts_at && new Date(v.starts_at).getTime() > now) || (v.ends_at && new Date(v.ends_at).getTime() < now) || subtotal < Number(v.min_order_amount) || (v.total_usage_limit !== null && v.used_count >= v.total_usage_limit)) {
        throw new AppError(400, 'INVALID_VOUCHER', 'Voucher không hợp lệ hoặc chưa đủ điều kiện đơn tối thiểu');
      }

      const count = await client.query('SELECT count(*) AS count FROM voucher_usages WHERE voucher_id=$1 AND user_id=$2', [v.id, req.user!.id]);
      if (v.per_user_limit !== null && (count.rows[0]?.count ?? 0) >= v.per_user_limit) {
        throw new AppError(400, 'VOUCHER_LIMIT', 'Đã hết lượt dùng voucher');
      }

      const allowed = await client.query('SELECT product_id FROM voucher_products WHERE voucher_id=$1', [v.id]);
      const eligibleSubtotal = allowed.rows.length ? lines.filter(line => allowed.rows.some(row => row.product_id === line.productId)).reduce((sum, line) => sum + line.total, 0) : subtotal;

      if (eligibleSubtotal === 0) throw new AppError(400, 'INVALID_VOUCHER', 'Voucher không áp dụng cho sản phẩm này');

      voucherId = v.id;
      totalDiscount = calcDiscount({
        type: v.type,
        valueAmount: v.value_amount && Number(v.value_amount),
        valuePercent: v.value_percent,
        maxDiscountAmount: v.max_discount_amount && Number(v.max_discount_amount),
      }, eligibleSubtotal);

      await client.query('UPDATE vouchers SET used_count=used_count+1 WHERE id=$1', [v.id]);
    }

    const finalTotalPayment = Math.max(0, subtotal - totalDiscount);

    // 4. Trừ tiền ví
    let walletBefore = 0;
    let walletAfter = 0;

    if (finalTotalPayment > 0) {
      const wallet = await client.query(
        'UPDATE wallets SET balance_amount=balance_amount-$2, version=version+1 WHERE user_id=$1 AND balance_amount>=$2 RETURNING balance_amount+$2 AS before,balance_amount AS after',
        [req.user!.id, finalTotalPayment]
      );

      if (!wallet.rows[0]) throw new AppError(409, 'INSUFFICIENT_BALANCE', 'Số dư không đủ để thanh toán');
      walletBefore = Number(wallet.rows[0].before);
      walletAfter = Number(wallet.rows[0].after);
    } else {
      const currentWallet = await client.query('SELECT balance_amount FROM wallets WHERE user_id=$1', [req.user!.id]);
      walletBefore = Number(currentWallet.rows[0]?.balance_amount ?? 0);
      walletAfter = walletBefore;
    }

    // 5. Nếu khách chọn tách đơn lẻ (splitOrders = true)
    if (input.splitOrders && lines.length > 1) {
      const createdOrders = [];
      let remainingDiscountToDistribute = totalDiscount;

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        let lineDiscount = 0;
        if (totalDiscount > 0) {
          if (i === lines.length - 1) {
            lineDiscount = remainingDiscountToDistribute;
          } else {
            lineDiscount = Math.floor((line.total / subtotal) * totalDiscount);
            remainingDiscountToDistribute -= lineDiscount;
          }
        }
        const lineFinal = line.total - lineDiscount;
        const lineOrderCode = code('ORD');
        const lineKey = `${key}_${i}`;

        const orderResult = await client.query(
          'INSERT INTO orders(order_code,user_id,idempotency_key,request_hash,status,subtotal_amount,discount_amount,total_amount,voucher_id,customer_note) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *',
          [lineOrderCode, req.user!.id, lineKey, requestHash, 'queued', line.total, lineDiscount, lineFinal, voucherId, input.customerNote ?? null]
        );
        const order = orderResult.rows[0]!;

        await client.query(
          'INSERT INTO order_items(order_id,product_id,product_name,unit_price,quantity,total_amount,customer_input) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)',
          [order.id, line.productId, line.name, line.unitPrice, line.quantity, line.total, JSON.stringify(line.customerInput)]
        );

        if (voucherId) {
          await client.query('INSERT INTO voucher_usages(voucher_id,user_id,order_id,discount_amount) VALUES($1,$2,$3,$4)', [voucherId, req.user!.id, order.id, lineDiscount]);
        }

        await client.query("INSERT INTO order_status_logs(order_id,to_status,actor_type,actor_id) VALUES($1,'queued','customer',$2)", [order.id, req.user!.id]);

        createdOrders.push(order);
      }

      await client.query(
        "INSERT INTO wallet_transactions(user_id,type,amount,balance_before,balance_after,reference_type,reference_id,status,description) VALUES($1,'purchase',$2,$3,$4,'order',$5,'completed',$6)",
        [req.user!.id, -finalTotalPayment, walletBefore, walletAfter, key, `Thanh toán ${lines.length} đơn hàng (${input.voucherCode ? `Áp mã ${input.voucherCode}` : 'Không áp mã'})`]
      );

      await client.query('COMMIT');
      res.status(201).json({
        split: true,
        orders: createdOrders,
        totalAmount: finalTotalPayment,
        discountAmount: totalDiscount,
      });
      return;
    }

    // 6. Trường hợp đơn thông thường
    const orderResult = await client.query(
      'INSERT INTO orders(order_code,user_id,idempotency_key,request_hash,status,subtotal_amount,discount_amount,total_amount,voucher_id,customer_note) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *',
      [code('ORD'), req.user!.id, key, requestHash, 'queued', subtotal, totalDiscount, finalTotalPayment, voucherId, input.customerNote ?? null]
    );
    const order = orderResult.rows[0];
    if (!order) throw new Error('Order insert did not return a row');

    for (const line of lines) {
      await client.query(
        'INSERT INTO order_items(order_id,product_id,product_name,unit_price,quantity,total_amount,customer_input) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)',
        [order.id, line.productId, line.name, line.unitPrice, line.quantity, line.total, JSON.stringify(line.customerInput)]
      );
    }

    if (voucherId) {
      await client.query('INSERT INTO voucher_usages(voucher_id,user_id,order_id,discount_amount) VALUES($1,$2,$3,$4)', [voucherId, req.user!.id, order.id, totalDiscount]);
    }

    await client.query(
      "INSERT INTO wallet_transactions(user_id,type,amount,balance_before,balance_after,reference_type,reference_id,status) VALUES($1,'purchase',$2,$3,$4,'order',$5,'completed')",
      [req.user!.id, -finalTotalPayment, walletBefore, walletAfter, order.id]
    );

    await client.query("INSERT INTO order_status_logs(order_id,to_status,actor_type,actor_id) VALUES($1,'queued','customer',$2)", [order.id, req.user!.id]);

    if (hasAnyProvider) {
      await client.query("INSERT INTO outbox_jobs(type,aggregate_id,payload) VALUES('SEND_PROVIDER_ORDER',$1,'{}'::jsonb)", [order.id]);
    }

    await client.query('COMMIT');
    res.status(201).json(order);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
});

orderRouter.get('/', async (req, res) => {
  const result = await sqlClient.query(`
    SELECT o.*,
      COALESCE(
        json_agg(
          json_build_object(
            'id', oi.id,
            'productId', oi.product_id,
            'productName', oi.product_name,
            'unitPrice', oi.unit_price,
            'quantity', oi.quantity,
            'totalAmount', oi.total_amount,
            'customerInput', oi.customer_input
          )
        ) FILTER (WHERE oi.id IS NOT NULL), '[]'::json
      ) AS items
    FROM orders o
    LEFT JOIN order_items oi ON oi.order_id = o.id
    WHERE o.user_id = $1
    GROUP BY o.id
    ORDER BY o.created_at DESC
    LIMIT 100
  `, [req.user!.id]);

  res.json(result.rows);
});

orderRouter.get('/:orderCode', async (req, res) => {
  const [order] = await db.select().from(orders).where(and(eq(orders.userId, req.user!.id), eq(orders.orderCode, String(req.params.orderCode))));
  if (!order) throw new AppError(404, 'NOT_FOUND', 'Không tìm thấy đơn hàng');
  res.json({ ...order, items: await db.select().from(orderItems).where(eq(orderItems.orderId, order.id)) });
});

adminOrderRouter.use(requireUser, requireAdmin);

adminOrderRouter.get('/', async (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(Math.max(1, Number(req.query.limit) || 20), 100);
  const offset = (page - 1) * limit;

  const conditions: string[] = [];
  const params: any[] = [];
  let paramIdx = 1;

  // Filter by userId
  if (req.query.userId) {
    conditions.push(`o.user_id = $${paramIdx++}`);
    params.push(String(req.query.userId));
  }

  // Filter by status (supports comma-separated for groups like "queued,sending,processing")
  if (req.query.status) {
    const statuses = String(req.query.status).split(',').map(s => s.trim()).filter(Boolean);
    if (statuses.length === 1) {
      conditions.push(`o.status = $${paramIdx++}`);
      params.push(statuses[0]);
    } else if (statuses.length > 1) {
      const placeholders = statuses.map(() => `$${paramIdx++}`).join(',');
      conditions.push(`o.status IN (${placeholders})`);
      params.push(...statuses);
    }
  }

  // Search by orderCode, user email, or customerInput values
  if (req.query.search) {
    const searchTerm = `%${String(req.query.search).trim().toLowerCase()}%`;
    conditions.push(`(LOWER(o.order_code) LIKE $${paramIdx} OR LOWER(u.email) LIKE $${paramIdx} OR LOWER(u.name) LIKE $${paramIdx} OR EXISTS (SELECT 1 FROM order_items oi2 WHERE oi2.order_id = o.id AND LOWER(oi2.customer_input::text) LIKE $${paramIdx}))`);
    params.push(searchTerm);
    paramIdx++;
  }

  const whereClause = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

  // Count total matching rows
  const countResult = await sqlClient.query(
    `SELECT count(DISTINCT o.id)::int AS total FROM orders o LEFT JOIN users u ON u.id = o.user_id ${whereClause}`,
    params
  );
  const total = countResult.rows[0]?.total ?? 0;

  // Fetch paginated data
  const dataParams = [...params, limit, offset];
  const result = await sqlClient.query(`
    SELECT o.*,
      json_build_object('id', u.id, 'email', u.email, 'name', u.name) AS "user",
      COALESCE(
        json_agg(
          json_build_object(
            'id', oi.id,
            'productId', oi.product_id,
            'productName', oi.product_name,
            'unitPrice', oi.unit_price,
            'quantity', oi.quantity,
            'totalAmount', oi.total_amount,
            'customerInput', oi.customer_input
          )
        ) FILTER (WHERE oi.id IS NOT NULL), '[]'::json
      ) AS items
    FROM orders o
    LEFT JOIN users u ON u.id = o.user_id
    LEFT JOIN order_items oi ON oi.order_id = o.id
    ${whereClause}
    GROUP BY o.id, u.id, u.email, u.name
    ORDER BY o.created_at DESC
    LIMIT $${paramIdx++} OFFSET $${paramIdx++}
  `, dataParams);

  res.json({
    data: result.rows,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    },
  });
});

adminOrderRouter.get('/:id', async (req, res) => {
  const [row] = await db.select().from(orders).where(eq(orders.id, String(req.params.id)));
  if (!row) throw new AppError(404, 'NOT_FOUND', 'Không tìm thấy đơn hàng');
  res.json({
    ...row,
    items: await db.select().from(orderItems).where(eq(orderItems.orderId, row.id)),
    statusLogs: await db.select().from(orderStatusLogs).where(eq(orderStatusLogs.orderId, row.id)).orderBy(orderStatusLogs.createdAt),
    providerOrders: await db.select().from(providerOrders).where(eq(providerOrders.orderId, row.id)),
  });
});

const transitions: Record<string, string[]> = {
  queued: ['processing', 'completed', 'cancelled', 'failed'],
  sending: ['processing', 'completed', 'failed'],
  processing: ['completed', 'failed'],
  failed: ['refunded', 'completed'],
  completed: [],
  refunded: [],
  cancelled: [],
};

adminOrderRouter.post('/batch-status', async (req, res) => {
  const { ids, status, reason } = parse(
    z.object({
      ids: z.array(z.string().uuid()).min(1).max(5000),
      status: z.enum(['cancelled', 'failed', 'completed']),
      reason: z.string().min(5).max(500),
    }),
    req.body
  );

  const client = await sqlClient.connect();
  try {
    await client.query('BEGIN');

    const inClause = ids.map((_, i) => `$${i + 2}`).join(',');
    const updateQuery = `
      UPDATE orders
      SET status = $1,
          updated_at = NOW(),
          completed_at = CASE WHEN $1 = 'completed' THEN NOW() ELSE completed_at END
      WHERE id IN (${inClause})
      RETURNING id, order_code, status
    `;

    const result = await client.query(updateQuery, [status, ...ids]);
    const updatedRows = result.rows;

    await client.query(
      "INSERT INTO audit_logs(actor_id, action, target_type, target_id, metadata) VALUES($1, 'order.batch_status', 'orders', $2, $3::jsonb)",
      [req.user!.id, 'batch', JSON.stringify({ count: updatedRows.length, status, reason })]
    );

    await client.query('COMMIT');
    res.json({
      success: true,
      updatedCount: updatedRows.length,
      orders: updatedRows,
    });
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
});

adminOrderRouter.patch('/:id/status', async (req, res) => {
  const { status, reason } = parse(z.object({ status: z.enum(['cancelled', 'failed', 'completed']), reason: z.string().min(5).max(500) }), req.body);
  const client = await sqlClient.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query('SELECT * FROM orders WHERE id=$1', [String(req.params.id)]);
    const row = result.rows[0];
    if (!row) throw new AppError(404, 'NOT_FOUND', 'Không tìm thấy đơn hàng');
    if (!transitions[row.status]?.includes(status)) throw new AppError(409, 'INVALID_TRANSITION', 'Chuyển trạng thái không hợp lệ');

    await client.query("UPDATE orders SET status=$2,updated_at=NOW(),completed_at=CASE WHEN $2='completed' THEN NOW() ELSE completed_at END WHERE id=$1", [String(row.id), status]);
    await client.query("INSERT INTO order_status_logs(order_id,from_status,to_status,actor_type,actor_id,reason) VALUES($1,$2,$3,'admin',$4,$5)", [row.id, row.status, status, req.user!.id, reason]);
    await client.query("INSERT INTO audit_logs(actor_id,action,target_type,target_id,metadata) VALUES($1,'order.status','order',$2,$3::jsonb)", [req.user!.id, row.id, JSON.stringify({ status, reason })]);
    await client.query('COMMIT');
    res.json({ status });
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
});

adminOrderRouter.post('/:id/refund', async (req, res) => {
  const { reason } = parse(z.object({ reason: z.string().min(5).max(500) }), req.body);
  const client = await sqlClient.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query('SELECT * FROM orders WHERE id=$1', [String(req.params.id)]);
    const row = result.rows[0];
    if (!row) throw new AppError(404, 'NOT_FOUND', 'Không tìm thấy đơn hàng');
    if (row.status !== 'failed') throw new AppError(409, 'INVALID_TRANSITION', 'Chỉ hoàn tiền đơn đã xác nhận thất bại');

    const wallet = await client.query('UPDATE wallets SET balance_amount=balance_amount+$2,version=version+1 WHERE user_id=$1 RETURNING balance_amount-$2 AS before,balance_amount AS after', [row.user_id, row.total_amount]);
    if (!wallet.rows[0]) throw new Error('Wallet missing');

    await client.query("INSERT INTO wallet_transactions(user_id,type,amount,balance_before,balance_after,reference_type,reference_id,status) VALUES($1,'refund',$2,$3,$4,'refund',$5,'completed')", [row.user_id, row.total_amount, wallet.rows[0].before, wallet.rows[0].after, `refund:order:${row.id}`]);
    await client.query("UPDATE orders SET status='refunded',updated_at=NOW() WHERE id=$1", [String(row.id)]);
    await client.query("INSERT INTO order_status_logs(order_id,from_status,to_status,actor_type,actor_id,reason) VALUES($1,'failed','refunded','admin',$2,$3)", [row.id, req.user!.id, reason]);
    await client.query("INSERT INTO audit_logs(actor_id,action,target_type,target_id,metadata) VALUES($1,'order.refund','order',$2,$3::jsonb)", [req.user!.id, row.id, JSON.stringify({ reason })]);
    await client.query('COMMIT');
    res.json({ refunded: true });
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
});

adminOrderRouter.post('/:id/retry', async (req, res) => {
  const [row] = await db.select().from(orders).where(eq(orders.id, String(req.params.id)));
  if (!row || row.status !== 'failed') throw new AppError(409, 'INVALID_TRANSITION', 'Đơn không thể gửi lại');
  await db.insert(auditLogs).values({ actorId: req.user!.id, action: 'order.retry', targetType: 'order', targetId: row.id });
  await sqlClient.query("INSERT INTO outbox_jobs(type,aggregate_id,payload) VALUES('SEND_PROVIDER_ORDER',$1,'{}'::jsonb)", [row.id]);
  res.json({ queued: true });
});

