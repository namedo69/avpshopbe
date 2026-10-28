import { Router } from 'express';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { providers } from '../db/schema.js';
import { sqlClient } from '../db/sql.js';
import { AppError, parse, requireAdmin, requireUser } from '../lib/core.js';
import { chungSucClient } from './chungsuc-adapter.js';

export const adminProviderRouter = Router();

adminProviderRouter.use(requireUser, requireAdmin);

/**
 * Đảm bảo provider 'chungsuc' đã tồn tại trong database
 */
async function ensureChungSucProvider() {
  const [existing] = await db.select().from(providers).where(eq(providers.code, 'chungsuc'));
  if (!existing) {
    const [created] = await db.insert(providers).values({
      code: 'chungsuc',
      name: 'Chung Sức Home API',
      baseUrl: process.env.CHUNGSUC_BASE_URL || 'https://chungsuc.io.vn/api/member/v1',
      isActive: false, // Mặc định tắt cho đến khi Admin chủ động bật
    }).returning();
    if (!created) throw new Error('Cannot create provider chungsuc');
    return created;
  }
  return existing;
}

/**
 * Lấy danh sách providers và trạng thái ví ChungSuc
 * GET /api/v1/admin/providers/chungsuc
 */
adminProviderRouter.get('/chungsuc', async (_req, res) => {
  const provider = await ensureChungSucProvider();
  let partnerInfo = null;
  let errorMsg = null;

  if (chungSucClient.isConfigured()) {
    try {
      partnerInfo = await chungSucClient.getMe();
    } catch (err: any) {
      errorMsg = err.message || 'Không thể kết nối đến máy chủ Chung Sức';
    }
  } else {
    errorMsg = 'CHUNGSUC_API_KEY chưa được cấu hình trên server';
  }

  res.json({
    provider: {
      id: provider.id,
      code: provider.code,
      name: provider.name,
      isActive: provider.isActive,
    },
    configured: chungSucClient.isConfigured(),
    partnerInfo,
    error: errorMsg,
  });
});

/**
 * Bật / Tắt trạng thái đẩy đơn sang ChungSuc
 * PATCH /api/v1/admin/providers/chungsuc/toggle
 */
adminProviderRouter.patch('/chungsuc/toggle', async (req, res) => {
  const schema = z.object({
    isActive: z.boolean().optional(),
  });
  const { isActive } = parse(schema, req.body);
  await ensureChungSucProvider();

  let targetState: boolean;
  if (typeof isActive === 'boolean') {
    targetState = isActive;
  } else {
    // Tự đảo ngược trạng thái nếu không truyền isActive
    const [current] = await db.select().from(providers).where(eq(providers.code, 'chungsuc'));
    targetState = !current?.isActive;
  }

  const [updated] = await db.update(providers)
    .set({ isActive: targetState })
    .where(eq(providers.code, 'chungsuc'))
    .returning();

  res.json({
    success: true,
    provider: {
      id: updated!.id,
      code: updated!.code,
      name: updated!.name,
      isActive: updated!.isActive,
    },
    message: updated!.isActive
      ? 'Đã BẬT tự động đẩy đơn sang Chung Sức'
      : 'Đã TẮT tự động đẩy đơn sang Chung Sức (đơn sẽ chờ xử lý thủ công)',
  });
});
