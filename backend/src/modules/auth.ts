import { Router } from 'express';
import { z } from 'zod';
import argon2 from 'argon2';
import { randomBytes } from 'node:crypto';
import { eq, and, gt, isNull } from 'drizzle-orm';
import { db } from '../db/index.js';
import { users, wallets, refreshSessions, userTiers } from '../db/schema.js';
import { AppError, accessToken, parse, requireUser, sha256 } from '../lib/core.js';

export const authRouter = Router();
export const meRouter = Router();
const credentials = z.object({ email: z.email().max(255).transform(x => x.toLowerCase()), password: z.string().min(1).max(200) });
const registration = credentials.extend({ password: z.string().min(8).max(200), name: z.string().trim().min(1).max(120) });
const cookieName = 'refresh_token';
function cookieOptions() {
  const isProd = process.env.NODE_ENV === 'production';
  return {
    httpOnly: true,
    secure: isProd,
    sameSite: isProd ? ('none' as const) : ('lax' as const),
    path: '/',
    maxAge: 30 * 86400 * 1000,
  };
}
async function issueSession(user: typeof users.$inferSelect, req: import('express').Request, res: import('express').Response) {
  const refresh = randomBytes(48).toString('base64url');
  await db.insert(refreshSessions).values({ userId: user.id, tokenHash: sha256(refresh), expiresAt: new Date(Date.now() + 30 * 86400_000), ip: req.ip, userAgent: req.header('user-agent') });
  res.cookie(cookieName, refresh, cookieOptions());

  // Lấy thông tin tier
  const tierResult = await db.query?.userTiers?.findFirst?.({ where: eq(userTiers.id, user.tierId ?? '') }) ?? null;

  return {
    accessToken: await accessToken(user.id, user.role),
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      tierId: user.tierId ?? (user.role === 'admin' ? 'tier_admin' : 'tier_member'),
    },
  };
}
authRouter.post('/register', async (req, res) => {
  const data = parse(registration, req.body);
  const hash = await argon2.hash(data.password, { type: argon2.argon2id });
  const result = await db.transaction(async tx => {
    const [user] = await tx.insert(users).values({ email: data.email, passwordHash: hash, name: data.name, tierId: 'tier_member' }).onConflictDoNothing().returning();
    if (!user) throw new AppError(409, 'EMAIL_EXISTS', 'Email đã được sử dụng');
    await tx.insert(wallets).values({ userId: user.id, balanceAmount: 0 });
    return user;
  });
  res.status(201).json(await issueSession(result, req, res));
});
authRouter.post('/login', async (req, res) => {
  const data = parse(credentials, req.body);
  const [user] = await db.select().from(users).where(eq(users.email, data.email));
  if (!user || user.status !== 'active' || !await argon2.verify(user.passwordHash, data.password)) throw new AppError(401, 'INVALID_CREDENTIALS', 'Email hoặc mật khẩu không đúng');
  res.json(await issueSession(user, req, res));
});
authRouter.post('/refresh', async (req, res) => {
  const token = req.cookies?.[cookieName];
  if (typeof token !== 'string') throw new AppError(401, 'UNAUTHORIZED', 'Phiên không hợp lệ');
  const [session] = await db.select().from(refreshSessions).where(and(eq(refreshSessions.tokenHash, sha256(token)), isNull(refreshSessions.revokedAt), gt(refreshSessions.expiresAt, new Date())));
  if (!session) throw new AppError(401, 'UNAUTHORIZED', 'Phiên đã hết hạn');
  const [claimed] = await db.update(refreshSessions).set({ revokedAt: new Date() }).where(and(eq(refreshSessions.id, session.id), isNull(refreshSessions.revokedAt))).returning();
  if (!claimed) throw new AppError(401, 'UNAUTHORIZED', 'Phiên đã được sử dụng');
  const [user] = await db.select().from(users).where(eq(users.id, session.userId));
  if (!user || user.status !== 'active') throw new AppError(401, 'UNAUTHORIZED', 'Tài khoản không hoạt động');
  res.json(await issueSession(user, req, res));
});
authRouter.post('/logout', async (req, res) => {
  const token = req.cookies?.[cookieName];
  if (typeof token === 'string') await db.update(refreshSessions).set({ revokedAt: new Date() }).where(eq(refreshSessions.tokenHash, sha256(token)));
  res.clearCookie(cookieName, cookieOptions()); res.status(204).end();
});
meRouter.get('/me', requireUser, async (req, res) => {
  const [user] = await db.select({
    id: users.id,
    email: users.email,
    name: users.name,
    role: users.role,
    status: users.status,
    tierId: users.tierId,
    tierName: userTiers.name,
    tierCode: userTiers.code,
    tierDiscount: userTiers.discountPercent,
  })
  .from(users)
  .leftJoin(userTiers, eq(users.tierId, userTiers.id))
  .where(eq(users.id, req.user!.id));

  if (!user || user.status !== 'active') throw new AppError(401, 'UNAUTHORIZED', 'Tài khoản không hoạt động');
  
  // Mặc định nếu là admin thì giảm 100%
  const effectiveDiscount = user.role === 'admin' ? 100 : (user.tierDiscount ?? 0);
  const effectiveTierName = user.role === 'admin' ? 'Quản trị viên' : (user.tierName ?? 'Thành viên');
  const effectiveTierCode = user.role === 'admin' ? 'admin' : (user.tierCode ?? 'thanh_vien');

  res.json({
    ...user,
    tierDiscount: effectiveDiscount,
    tierName: effectiveTierName,
    tierCode: effectiveTierCode,
  });
});
