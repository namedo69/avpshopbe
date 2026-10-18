import { Router } from 'express';
import { sqlClient } from '../db/sql.js';
import { requireAdmin, requireUser } from '../lib/core.js';

export const reportRouter = Router();
reportRouter.use(requireUser, requireAdmin);
reportRouter.get('/orders', async (_req, res) => {
  const result = await sqlClient.query("SELECT status, count(*) AS count, coalesce(sum(total_amount),0) AS total_amount FROM orders GROUP BY status");
  res.json(result.rows);
});
reportRouter.get('/cashflow', async (_req, res) => {
  const result = await sqlClient.query("SELECT type, count(*) AS count, coalesce(sum(amount),0) AS amount FROM wallet_transactions WHERE status='completed' GROUP BY type");
  res.json(result.rows);
});
