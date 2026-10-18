import { Router } from 'express';
import { z } from 'zod';
import { and, desc, eq, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { auditLogs, products, vouchers, voucherProducts, providerProducts, voucherUsages } from '../db/schema.js';
import { AppError, amountSchema, calcDiscount, parse, requireAdmin, requireUser } from '../lib/core.js';

export const productRouter = Router();
export const adminProductRouter = Router();
export const voucherRouter = Router();
export const adminVoucherRouter = Router();
const productInput = z.object({
  name: z.string().trim().min(1).max(200), slug: z.string().regex(/^[a-z0-9-]+$/).max(200), description: z.string().max(5000).nullable().optional(),
  categoryId: z.uuid().nullable().optional(), imageUrl: z.url().nullable().optional(), priceAmount: amountSchema,
  salePriceAmount: amountSchema.nullable().optional(), inputSchema: z.record(z.string(), z.unknown()).default({}),
  minQuantity: z.number().int().min(1).max(10000).default(1), maxQuantity: z.number().int().min(1).max(10000).default(1),
  isActive: z.boolean().default(true), sortOrder: z.number().int().default(0),
}).refine(x => x.maxQuantity >= x.minQuantity && (!x.salePriceAmount || x.salePriceAmount <= x.priceAmount));
productRouter.get('/', async (_req, res) => res.json(await db.select().from(products).where(eq(products.isActive, true)).orderBy(products.sortOrder).limit(200)));
productRouter.get('/:slug', async (req, res) => {
  const [row] = await db.select().from(products).where(and(eq(products.slug, String(req.params.slug)), eq(products.isActive, true)));
  if (!row) throw new AppError(404, 'NOT_FOUND', 'Không tìm thấy sản phẩm'); res.json(row);
});
adminProductRouter.use(requireUser, requireAdmin);
adminProductRouter.get('/', async (_req, res) => res.json(await db.select().from(products).orderBy(desc(products.createdAt)).limit(200)));
adminProductRouter.post('/', async (req, res) => {
  const input = parse(productInput, req.body);
  const [row] = await db.insert(products).values(input).returning();
  await db.insert(auditLogs).values({ actorId: req.user!.id, action: 'product.create', targetType: 'product', targetId: row!.id });
  res.status(201).json(row);
});
adminProductRouter.patch('/:id', async (req, res) => {
  const input = parse(productInput.safeExtend({}).partial(), req.body);
  const [row] = await db.update(products).set({ ...input, updatedAt: new Date() }).where(eq(products.id, String(req.params.id))).returning();
  if (!row) throw new AppError(404, 'NOT_FOUND', 'Không tìm thấy sản phẩm');
  await db.insert(auditLogs).values({ actorId: req.user!.id, action: 'product.update', targetType: 'product', targetId: row.id, metadata: input });
  res.json(row);
});
adminProductRouter.delete('/:id', async (req, res) => {
  const [row] = await db.update(products).set({ isActive: false, updatedAt: new Date() }).where(eq(products.id, String(req.params.id))).returning();
  if (!row) throw new AppError(404, 'NOT_FOUND', 'Không tìm thấy sản phẩm');
  await db.insert(auditLogs).values({ actorId: req.user!.id, action: 'product.deactivate', targetType: 'product', targetId: row.id });
  res.status(204).end();
});
adminProductRouter.post('/:id/provider', async (req, res) => {
  const input = parse(z.object({ providerId: z.uuid(), externalServiceId: z.string().min(1).max(100), costAmount: z.number().int().safe().min(0), priority: z.number().int().default(0), providerPayloadTemplate: z.record(z.string(), z.unknown()).default({}) }), req.body);
  const [row] = await db.insert(providerProducts).values({ ...input, productId: String(req.params.id) }).returning();
  await db.insert(auditLogs).values({ actorId: req.user!.id, action: 'product.provider.add', targetType: 'product', targetId: String(req.params.id) });
  res.status(201).json(row);
});
const voucherInput = z.object({
  code: z.string().trim().min(3).max(40).regex(/^[A-Za-z0-9_-]+$/).transform(x => x.toUpperCase()), type: z.enum(['percent', 'fixed']),
  valueAmount: amountSchema.nullable().optional(), valuePercent: z.number().int().min(1).max(100).nullable().optional(),
  maxDiscountAmount: amountSchema.nullable().optional(), minOrderAmount: z.number().int().safe().min(0).default(0),
  totalUsageLimit: z.number().int().positive().nullable().optional(), perUserLimit: z.number().int().positive().nullable().optional(),
  startsAt: z.coerce.date().nullable().optional(), endsAt: z.coerce.date().nullable().optional(), isActive: z.boolean().default(true),
  productIds: z.array(z.uuid()).default([]),
}).refine(x => x.type === 'fixed' ? !!x.valueAmount : !!x.valuePercent);
adminVoucherRouter.use(requireUser, requireAdmin);
adminVoucherRouter.get('/', async (_req, res) => res.json(await db.select().from(vouchers).limit(200)));
adminVoucherRouter.post('/', async (req, res) => {
  const { productIds, ...input } = parse(voucherInput, req.body);
  const row = await db.transaction(async tx => {
    const [v] = await tx.insert(vouchers).values(input).returning();
    if (productIds.length) await tx.insert(voucherProducts).values(productIds.map(productId => ({ voucherId: v!.id, productId })));
    await tx.insert(auditLogs).values({ actorId: req.user!.id, action: 'voucher.create', targetType: 'voucher', targetId: v!.id });
    return v;
  });
  res.status(201).json(row);
});
adminVoucherRouter.patch('/:id', async (req, res) => {
  const input = parse(voucherInput.safeExtend({}).partial(), req.body);
  const { productIds, ...values } = input;
  const row = await db.transaction(async tx => {
    const [v] = await tx.update(vouchers).set(values).where(eq(vouchers.id, String(req.params.id))).returning();
    if (!v) throw new AppError(404, 'NOT_FOUND', 'Không tìm thấy voucher');
    if (productIds) { await tx.delete(voucherProducts).where(eq(voucherProducts.voucherId, v.id)); if (productIds.length) await tx.insert(voucherProducts).values(productIds.map((productId: string) => ({ voucherId: v.id, productId }))); }
    await tx.insert(auditLogs).values({ actorId: req.user!.id, action: 'voucher.update', targetType: 'voucher', targetId: v.id }); return v;
  }); res.json(row);
});
adminVoucherRouter.delete('/:id', async (req, res) => {
  const [row] = await db.update(vouchers).set({ isActive: false }).where(eq(vouchers.id, String(req.params.id))).returning();
  if (!row) throw new AppError(404, 'NOT_FOUND', 'Không tìm thấy voucher'); res.status(204).end();
});
voucherRouter.use(requireUser);
voucherRouter.post('/validate', async (req, res) => {
  const { code, items } = parse(z.object({ code: z.string(), items: z.array(z.object({ productId: z.uuid(), quantity: z.number().int().positive() })).min(1).max(20) }), req.body);
  const [v] = await db.select().from(vouchers).where(eq(vouchers.code, code.toUpperCase()));
  if (!v || !v.isActive || (v.startsAt && v.startsAt > new Date()) || (v.endsAt && v.endsAt < new Date()) || (v.totalUsageLimit !== null && v.usedCount >= v.totalUsageLimit)) throw new AppError(400, 'INVALID_VOUCHER', 'Voucher không hợp lệ');
  if (v.perUserLimit !== null) {
    const [count] = await db.select({ count: sql<number>`count(*)` }).from(voucherUsages).where(and(eq(voucherUsages.voucherId, v.id), eq(voucherUsages.userId, req.user!.id)));
    if ((count?.count ?? 0) >= v.perUserLimit) throw new AppError(400, 'VOUCHER_LIMIT', 'Đã hết lượt dùng voucher');
  }
  const restricted = await db.select({ productId: voucherProducts.productId }).from(voucherProducts).where(eq(voucherProducts.voucherId, v.id));
  let subtotal = 0, eligibleSubtotal = 0;
  for (const item of items) {
    const [product] = await db.select().from(products).where(and(eq(products.id, item.productId), eq(products.isActive, true)));
    if (!product || item.quantity < product.minQuantity || item.quantity > product.maxQuantity) throw new AppError(400, 'INVALID_PRODUCT', 'Sản phẩm không hợp lệ');
    const line = (product.salePriceAmount ?? product.priceAmount) * item.quantity;
    subtotal += line;
    if (!restricted.length || restricted.some(row => row.productId === item.productId)) eligibleSubtotal += line;
  }
  if (!Number.isSafeInteger(subtotal) || subtotal < v.minOrderAmount || eligibleSubtotal === 0) throw new AppError(400, 'INVALID_VOUCHER', 'Voucher không hợp lệ');
  res.json({ code: v.code, subtotal, estimatedDiscount: calcDiscount(v, eligibleSubtotal) });
});
