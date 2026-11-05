import { Router } from 'express';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { groupChestJobItems, groupChestJobs, orders } from '../db/schema.js';
import { AppError, requireUser } from '../lib/core.js';

export const groupChestRouter = Router();
groupChestRouter.use(requireUser);

const itemSchema = z.union([
  z.string().transform((str, ctx) => {
    const raw = str.trim();
    const parts = raw.includes(':') ? raw.split(':') : raw.split('|');
    const user = parts[0]?.trim() || '';
    const pass = parts[1]?.trim() || '';
    if (!user || !pass) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Tài khoản không đúng định dạng user|pass hoặc user:pass' });
      return z.NEVER;
    }
    return { externalAccountId: user, credentialRef: pass, username: user, password: pass };
  }),
  z.object({
    externalAccountId: z.string().trim().optional(),
    credentialRef: z.string().trim().optional(),
    username: z.string().trim().optional(),
    password: z.string().trim().optional(),
  }).transform((obj, ctx) => {
    const user = (obj.username || obj.externalAccountId || '').trim();
    const pass = (obj.password || obj.credentialRef || '').trim();
    if (!user || !pass) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Tài khoản và mật khẩu không được để trống' });
      return z.NEVER;
    }
    return { externalAccountId: user, credentialRef: pass, username: user, password: pass };
  }),
]);

groupChestRouter.get('/:orderCode', async (req, res) => {
  const [order] = await db.select().from(orders).where(and(eq(orders.orderCode, String(req.params.orderCode)), eq(orders.userId, req.user!.id)));
  if (!order) throw new AppError(404, 'NOT_FOUND', 'Không tìm thấy đơn hàng');
  const [job] = await db.select().from(groupChestJobs).where(eq(groupChestJobs.orderId, order.id));
  if (!job) throw new AppError(404, 'NOT_GROUP_CHEST_ORDER', 'Đơn hàng không thuộc sản phẩm Mở rương nhóm');
  const items = await db.select().from(groupChestJobItems).where(eq(groupChestJobItems.jobId, job.id));
  res.json({ ...job, items });
});

export function parseGroupChestInput(input: unknown) {
  const parsed = z.object({
    productType: z.literal('group_chest_open'),
    accounts: z.array(itemSchema).min(1).max(100),
    mode: z.enum(['standard', 'dry_run']).default('standard'),
  }).safeParse(input);
  return parsed.success ? parsed.data : null;
}

export async function createGroupChestJob(orderId: string, productId: string, input: unknown) {
  const data = parseGroupChestInput(input);
  if (!data) throw new AppError(400, 'INVALID_GROUP_CHEST_INPUT', 'Danh sách tài khoản nhóm không hợp lệ');
  const [job] = await db.insert(groupChestJobs).values({ orderId, productId, itemCount: data.accounts.length, resultSummary: { mode: data.mode } }).returning();
  if (!job) throw new Error('Group chest job was not created');
  await db.insert(groupChestJobItems).values(data.accounts.map(item => ({ jobId: job.id, externalAccountId: item.externalAccountId, credentialRef: item.credentialRef })));
  return job;
}
