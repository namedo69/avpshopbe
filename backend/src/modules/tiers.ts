import { Router } from 'express';
import { z } from 'zod';
import { eq, desc, sql, asc } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db } from '../db/index.js';
import { userTiers, tierProductPrices, products, users, auditLogs } from '../db/schema.js';
import { sqlClient } from '../db/sql.js';
import { AppError, parse, requireAdmin, requireUser, amountSchema } from '../lib/core.js';

export const tierRouter = Router();
export const adminTierRouter = Router();

// Public / User: Lấy danh sách các loại người dùng đang kích hoạt
tierRouter.get('/', async (_req, res) => {
  const list = await db
    .select({
      id: userTiers.id,
      code: userTiers.code,
      name: userTiers.name,
      discountPercent: userTiers.discountPercent,
      description: userTiers.description,
      isDefault: userTiers.isDefault,
    })
    .from(userTiers)
    .where(eq(userTiers.isActive, true))
    .orderBy(asc(userTiers.sortOrder));

  res.json(list);
});

// ADMIN ROUTES
adminTierRouter.use(requireUser, requireAdmin);

// Lấy danh sách toàn bộ loại người dùng kèm thống kê số tài khoản thuộc loại
adminTierRouter.get('/', async (_req, res) => {
  const result = await sqlClient.query(`
    SELECT 
      ut.*,
      COUNT(u.id) AS user_count
    FROM user_tiers ut
    LEFT JOIN users u ON u.tier_id = ut.id
    GROUP BY ut.id
    ORDER BY ut.sort_order ASC, ut.created_at ASC
  `);

  const list = result.rows.map(row => ({
    id: row.id,
    code: row.code,
    name: row.name,
    discountPercent: Number(row.discount_percent) || 0,
    description: row.description,
    isDefault: Boolean(row.is_default),
    isActive: Boolean(row.is_active),
    sortOrder: Number(row.sort_order) || 0,
    userCount: Number(row.user_count) || 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));

  res.json(list);
});

const tierInput = z.object({
  code: z.string().trim().min(2).max(40).regex(/^[a-z0-9_-]+$/),
  name: z.string().trim().min(2).max(100),
  discountPercent: z.number().int().min(0).max(100).default(0),
  description: z.string().max(500).optional().nullable(),
  isDefault: z.boolean().default(false),
  isActive: z.boolean().default(true),
  sortOrder: z.number().int().default(0),
});

const tierUpdateInput = tierInput.partial();

// Tạo loại người dùng mới
adminTierRouter.post('/', async (req, res) => {
  const data = parse(tierInput, req.body);
  const id = `tier_${data.code}`;

  // Kiểm tra trùng code
  const [existing] = await db.select().from(userTiers).where(eq(userTiers.code, data.code));
  if (existing) {
    throw new AppError(400, 'TIER_EXISTS', `Mã loại người dùng '${data.code}' đã tồn tại`);
  }

  // Nếu đặt là mặc định, bỏ cờ isDefault của các tier khác
  if (data.isDefault) {
    await db.update(userTiers).set({ isDefault: false });
  }

  const [created] = await db
    .insert(userTiers)
    .values({
      id,
      code: data.code,
      name: data.name,
      discountPercent: data.discountPercent,
      description: data.description ?? null,
      isDefault: data.isDefault,
      isActive: data.isActive,
      sortOrder: data.sortOrder,
    })
    .returning();

  if (!created) throw new AppError(500, 'INTERNAL_ERROR', 'Không thể tạo loại người dùng');

  await db.insert(auditLogs).values({
    actorId: req.user!.id,
    action: 'tier.create',
    targetType: 'user_tier',
    targetId: created.id,
    metadata: data,
  });

  res.status(201).json(created);
});

// Chỉnh sửa loại người dùng
adminTierRouter.patch('/:id', async (req, res) => {
  const id = String(req.params.id);
  const data = parse(tierUpdateInput, req.body);

  const [tier] = await db.select().from(userTiers).where(eq(userTiers.id, id));
  if (!tier) throw new AppError(404, 'NOT_FOUND', 'Không tìm thấy loại người dùng');

  // Đảm bảo loại admin luôn giảm 100%
  if (tier.code === 'admin') {
    if (data.discountPercent !== undefined && data.discountPercent !== 100) {
      data.discountPercent = 100;
    }
  }

  if (data.isDefault) {
    await db.update(userTiers).set({ isDefault: false });
  }

  const [updated] = await db
    .update(userTiers)
    .set({
      ...data,
      updatedAt: new Date(),
    })
    .where(eq(userTiers.id, id))
    .returning();

  if (!updated) throw new AppError(404, 'NOT_FOUND', 'Không tìm thấy loại người dùng');

  await db.insert(auditLogs).values({
    actorId: req.user!.id,
    action: 'tier.update',
    targetType: 'user_tier',
    targetId: id,
    metadata: data,
  });

  res.json(updated);
});

// Xóa loại người dùng (không xóa được admin hoặc default tier)
adminTierRouter.delete('/:id', async (req, res) => {
  const id = String(req.params.id);
  const [tier] = await db.select().from(userTiers).where(eq(userTiers.id, id));
  if (!tier) throw new AppError(404, 'NOT_FOUND', 'Không tìm thấy loại người dùng');

  if (tier.code === 'admin') {
    throw new AppError(400, 'CANNOT_DELETE_ADMIN_TIER', 'Không thể xóa loại người dùng Admin');
  }
  if (tier.isDefault) {
    throw new AppError(400, 'CANNOT_DELETE_DEFAULT_TIER', 'Không thể xóa loại người dùng mặc định');
  }

  // Chuyển toàn bộ user đang dùng tier này sang tier mặc định
  const [defaultTier] = await db.select().from(userTiers).where(eq(userTiers.isDefault, true));
  const fallbackId = defaultTier?.id ?? 'tier_member';
  await db.update(users).set({ tierId: fallbackId }).where(eq(users.tierId, id));

  // Xóa cấu hình giá sản phẩm của tier này
  await db.delete(tierProductPrices).where(eq(tierProductPrices.tierId, id));

  // Xóa tier
  await db.delete(userTiers).where(eq(userTiers.id, id));

  await db.insert(auditLogs).values({
    actorId: req.user!.id,
    action: 'tier.delete',
    targetType: 'user_tier',
    targetId: id,
  });

  res.status(204).end();
});

// =================== CẤU HÌNH GIÁ THEO SẢN PHẨM CHO TIER ===================

// Lấy danh sách sản phẩm và giá custom tương ứng của 1 tier
adminTierRouter.get('/:id/prices', async (req, res) => {
  const tierId = String(req.params.id);
  const [tier] = await db.select().from(userTiers).where(eq(userTiers.id, tierId));
  if (!tier) throw new AppError(404, 'NOT_FOUND', 'Không tìm thấy loại người dùng');

  const result = await sqlClient.query(`
    SELECT 
      p.id AS product_id,
      p.name AS product_name,
      p.slug AS product_slug,
      p.price_amount,
      p.sale_price_amount,
      tpp.custom_price_amount,
      tpp.id AS price_id
    FROM products p
    LEFT JOIN tier_product_prices tpp ON tpp.product_id = p.id AND tpp.tier_id = $1
    WHERE p.is_active = true
    ORDER BY p.sort_order ASC, p.created_at ASC
  `, [tierId]);

  res.json({
    tier,
    products: result.rows.map(row => ({
      productId: row.product_id,
      productName: row.product_name,
      productSlug: row.product_slug,
      originalPrice: Number(row.price_amount),
      salePrice: row.sale_price_amount ? Number(row.sale_price_amount) : null,
      customPrice: row.custom_price_amount !== null && row.custom_price_amount !== undefined ? Number(row.custom_price_amount) : null,
    })),
  });
});

// Cập nhật giá custom cho 1 sản phẩm thuộc tier
const setCustomPriceSchema = z.object({
  productId: z.string().uuid(),
  customPriceAmount: amountSchema.nullable(), // null = xóa giá custom, sử dụng % chiết khấu của tier
});

adminTierRouter.post('/:id/prices', async (req, res) => {
  const tierId = String(req.params.id);
  const { productId, customPriceAmount } = parse(setCustomPriceSchema, req.body);

  const [tier] = await db.select().from(userTiers).where(eq(userTiers.id, tierId));
  if (!tier) throw new AppError(404, 'NOT_FOUND', 'Không tìm thấy loại người dùng');

  if (customPriceAmount === null) {
    await db.delete(tierProductPrices).where(
      eq(tierProductPrices.tierId, tierId) && eq(tierProductPrices.productId, productId)
    );
    res.json({ success: true, message: 'Đã xóa giá tùy chỉnh, áp dụng theo chiết khấu % của loại' });
    return;
  }

  const existing = await sqlClient.query(
    'SELECT id FROM tier_product_prices WHERE tier_id = $1 AND product_id = $2',
    [tierId, productId]
  );

  if (existing.rows.length > 0) {
    await sqlClient.query(
      'UPDATE tier_product_prices SET custom_price_amount = $1, updated_at = NOW() WHERE tier_id = $2 AND product_id = $3',
      [customPriceAmount, tierId, productId]
    );
  } else {
    await sqlClient.query(
      'INSERT INTO tier_product_prices (id, tier_id, product_id, custom_price_amount) VALUES ($1, $2, $3, $4)',
      [randomUUID(), tierId, productId, customPriceAmount]
    );
  }

  res.json({ success: true, tierId, productId, customPriceAmount });
});
