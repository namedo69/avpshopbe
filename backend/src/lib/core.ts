import { randomBytes, createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { SignJWT, jwtVerify } from 'jose';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { users } from '../db/schema.js';

export class AppError extends Error {
  constructor(public status: number, public code: string, message: string, public fields: Record<string, unknown> = {}) { super(message); }
}

const rawOrigins = process.env.FRONTEND_ORIGIN || 'http://localhost:5173';
// Hỗ trợ danh sách nhiều origin cách nhau bằng dấu phẩy
export const allowedOrigins = rawOrigins.split(',').map(s => s.trim().replace(/\/$/, ''));

export const env = {
  accessSecret: process.env.JWT_ACCESS_SECRET ?? '',
  sepaySecret: process.env.SEPAY_WEBHOOK_SECRET ?? '',
  paymentPrefix: process.env.SEPAY_PAYMENT_PREFIX ?? 'NAP',
  frontendOrigin: rawOrigins,
};

export function assertConfig() {
  if (!process.env.TURSO_DATABASE_URL) throw new Error('TURSO_DATABASE_URL is required');
  if (process.env.NODE_ENV === 'production' && !process.env.TURSO_AUTH_TOKEN) throw new Error('TURSO_AUTH_TOKEN is required in production');
  if (env.accessSecret.length < 32) throw new Error('JWT_ACCESS_SECRET must be at least 32 characters');
  if (env.sepaySecret.length < 16) throw new Error('SEPAY_WEBHOOK_SECRET must be at least 16 characters');
}
export const code = (prefix: string) => `${prefix}${randomBytes(8).toString('hex').toUpperCase()}`;
export const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
export const safeEqual = (a: string, b: string) => {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

export function verifySepay(raw: Buffer, req: Request) {
  // 1. Kiểm tra qua API Key trong Header Authorization: Apikey <KEY>
  const authHeader = req.header('authorization') ?? '';
  if (authHeader) {
    const token = authHeader.replace(/^Apikey\s+/i, '').trim();
    if (token && safeEqual(token, env.sepaySecret)) {
      return true;
    }
  }

  // 2. Kiểm tra qua chữ ký HMAC-SHA256 (x-sepay-signature)
  const signature = req.header('x-sepay-signature') ?? '';
  const timestamp = req.header('x-sepay-timestamp') ?? '';
  if (signature && timestamp) {
    const seconds = Number(timestamp);
    if (Number.isSafeInteger(seconds) && Math.abs(Date.now() / 1000 - seconds) <= 300) {
      const expected = `sha256=${createHmac('sha256', env.sepaySecret).update(timestamp).update('.').update(raw).digest('hex')}`;
      if (safeEqual(signature, expected)) {
        return true;
      }
    }
  }

  return false;
}

export async function accessToken(userId: string, role: string) {
  return new SignJWT({ role }).setProtectedHeader({ alg: 'HS256' }).setSubject(userId).setIssuedAt().setExpirationTime('15m').sign(new TextEncoder().encode(env.accessSecret));
}
export async function requireUser(req: Request, _res: Response, next: NextFunction) {
  try {
    const match = /^Bearer (.+)$/.exec(req.header('authorization') ?? '');
    if (!match) throw new AppError(401, 'UNAUTHORIZED', 'Cần đăng nhập');
    const { payload } = await jwtVerify(match[1]!, new TextEncoder().encode(env.accessSecret));
    if (!payload.sub) throw new AppError(401, 'UNAUTHORIZED', 'Token không hợp lệ');
    const [user] = await db.select({ id: users.id, role: users.role, status: users.status }).from(users).where(eq(users.id, payload.sub));
    if (!user || user.status !== 'active') throw new AppError(401, 'UNAUTHORIZED', 'Tài khoản không hoạt động');
    req.user = { id: user.id, role: user.role };
    next();
  } catch (error) { next(error instanceof AppError ? error : new AppError(401, 'UNAUTHORIZED', 'Token không hợp lệ')); }
}
export function requireAdmin(req: Request, _res: Response, next: NextFunction) {
  if (req.user?.role !== 'admin') return next(new AppError(403, 'FORBIDDEN', 'Không có quyền truy cập'));
  next();
}
export function parse<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const result = schema.safeParse(value);
  if (!result.success) throw new AppError(400, 'VALIDATION_ERROR', 'Dữ liệu không hợp lệ', z.flattenError(result.error).fieldErrors);
  return result.data;
}
export const amountSchema = z.number().int().safe().positive().max(1_000_000_000_000);
export function calcDiscount(v: { type: string; valueAmount: number | null; valuePercent: number | null; maxDiscountAmount: number | null }, subtotal: number) {
  const raw = v.type === 'fixed' ? (v.valueAmount ?? 0) : Math.floor(subtotal * (v.valuePercent ?? 0) / 100);
  return Math.min(subtotal, v.maxDiscountAmount ?? Number.MAX_SAFE_INTEGER, raw);
}
declare global { namespace Express { interface Request { user?: { id: string; role: string }; requestId?: string; } } }
