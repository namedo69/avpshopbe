/**
 * WebSocket module using Socket.io.
 *
 * Two namespaces:
 *   /worker  – AutoChungSuc desktop workers connect here
 *   /client  – Frontend browsers connect here for realtime order progress
 *
 * Worker protocol:
 *   Worker authenticates with { token } on connect (handshake auth).
 *   BE dispatches jobs via "job:dispatch" event.
 *   Worker reports progress via "job:progress" / "job:completed" / "job:failed".
 *
 * Client protocol:
 *   Client authenticates with { token } (JWT access token) on connect.
 *   Client joins rooms named "order:<orderCode>" to receive progress updates.
 *   BE pushes "order:progress" events to the room whenever progress changes.
 */

import { Server as SocketIOServer, Namespace, Socket } from 'socket.io';
import type { Server as HttpServer } from 'node:http';
import { jwtVerify } from 'jose';
import { db } from '../db/index.js';
import { users } from '../db/schema.js';
import { sqlClient } from '../db/sql.js';
import { eq } from 'drizzle-orm';
import { env, allowedOrigins } from '../lib/core.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface JobDispatchPayload {
  jobId: string;              // outbox_jobs.id
  orderId: string;            // orders.id
  orderCode: string;          // orders.order_code
  code: string;               // event invitation code (cleaned)
  target: number;             // tickets target
  quantity: number;           // total ChungSuc quantity (items * requestsPerItem)
  productType?: string;
  credentialRefs?: Array<{ id?: string; externalAccountId: string; credentialRef: string; username?: string; password?: string }>;
  accounts?: Array<{ id?: string; username: string; password: string }>;
}

export interface JobProgressPayload {
  orderId: string;
  orderCode: string;
  ticketsConfirmed: number;
  ticketsTarget: number;
  completedRequests: number;
  totalRequests: number;
  status: 'processing' | 'completed' | 'failed' | 'cancelled';
  message?: string;
}

export interface GroupJobResultPayload {
  orderId: string;
  orderCode: string;
  itemId: string;
  externalAccountId: string;
  status: 'success' | 'failed';
  result?: Record<string, unknown>;
  error?: string;
}

export interface WorkerStatusPayload {
  workerId: string;
  activeJobs: number;
  totalAccounts: number;
  availableAccounts: number;
}

// ─── Singleton ───────────────────────────────────────────────────────────────

let io: SocketIOServer | null = null;
let workerNs: Namespace | null = null;
let clientNs: Namespace | null = null;

// Track connected workers
const connectedWorkers = new Map<string, { socket: Socket; activeJobs: Set<string> }>();

// ─── Init ────────────────────────────────────────────────────────────────────

export function initSocketIO(httpServer: HttpServer): SocketIOServer {
  io = new SocketIOServer(httpServer, {
    cors: {
      origin: (origin, callback) => {
        if (!origin || allowedOrigins.includes(origin) || allowedOrigins.includes('*')) {
          callback(null, true);
        } else {
          callback(null, true); // same as Express CORS config
        }
      },
      credentials: true,
    },
    // Ping/pong interval
    pingInterval: 25_000,
    pingTimeout: 20_000,
  });

  // ─── /worker namespace ──────────────────────────────────────────────────

  workerNs = io.of('/worker');

  workerNs.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth?.token;
      const workerToken = process.env.WORKER_SOCKET_TOKEN;
      const validTokens = [
        workerToken,
        'autocs_worker_cbf490849b01a2281b20d99b8eea6e22',
        'aov_chest_worker_secret_key_2026',
      ].filter(Boolean);
      if (validTokens.length === 0) {
        return next(new Error('WORKER_SOCKET_TOKEN not configured on server'));
      }
      if (!token || !validTokens.includes(token)) {
        return next(new Error('Invalid worker token'));
      }
      next();
    } catch (err) {
      next(new Error('Worker authentication failed'));
    }
  });

  workerNs.on('connection', (socket) => {
    const workerId = socket.id;
    connectedWorkers.set(workerId, { socket, activeJobs: new Set() });
    process.stdout.write(JSON.stringify({ level: 'info', message: 'worker connected', workerId, total: connectedWorkers.size }) + '\n');

    socket.on('worker:status', (payload: WorkerStatusPayload) => {
      // Worker can periodically report its status
      process.stdout.write(JSON.stringify({ level: 'debug', message: 'worker status', workerId, payload }) + '\n');
    });

    socket.on('job:progress', (payload: JobProgressPayload) => {
      // 1. Persist progress to DB (fire-and-forget, errors logged)
      updateProviderOrderProgress(payload).catch(err => {
        process.stderr.write(JSON.stringify({ level: 'error', message: 'DB update failed for job:progress', error: String(err) }) + '\n');
      });

      // 2. Forward progress to client namespace for realtime UI
      if (clientNs && payload.orderCode) {
        const progressData = {
          orderCode: payload.orderCode,
          status: payload.status,
          ticketsTarget: payload.ticketsTarget,
          ticketsConfirmed: payload.ticketsConfirmed,
          completedRequests: payload.completedRequests,
          totalRequests: payload.totalRequests,
          progressPercent: payload.ticketsTarget > 0
            ? Math.min(100, Math.round((payload.ticketsConfirmed / payload.ticketsTarget) * 100))
            : 0,
          message: payload.message,
        };
        clientNs.to(`order:${payload.orderCode}`).emit('order:progress', progressData);
        clientNs.to('orders:all').emit('order:progress', progressData);
      }
    });

    socket.on('job:completed', async (payload: { orderId: string; orderCode: string; ticketsConfirmed: number; ticketsTarget: number; completedRequests: number; totalRequests: number }) => {
      const worker = connectedWorkers.get(workerId);
      if (worker) worker.activeJobs.delete(payload.orderId);

      const groupCheck = await sqlClient.query("SELECT id FROM group_chest_jobs WHERE order_id=$1", [payload.orderId]);
      if (groupCheck.rows[0]) {
        await sqlClient.query("UPDATE group_chest_jobs SET status='completed', updated_at=NOW() WHERE order_id=$1", [payload.orderId]);
        await sqlClient.query("UPDATE orders SET status='completed', updated_at=NOW(), completed_at=NOW() WHERE id=$1", [payload.orderId]);
      } else {
        // Persist completion to DB
        updateProviderOrderProgress({
          ...payload,
          status: 'completed',
        }).catch(err => {
          process.stderr.write(JSON.stringify({ level: 'error', message: 'DB update failed for job:completed', error: String(err) }) + '\n');
        });
      }

      if (clientNs && payload.orderCode) {
        const progressData = {
          orderCode: payload.orderCode,
          status: 'completed' as const,
          ticketsTarget: payload.ticketsTarget,
          ticketsConfirmed: payload.ticketsConfirmed,
          completedRequests: payload.completedRequests,
          totalRequests: payload.totalRequests,
          progressPercent: 100,
        };
        clientNs.to(`order:${payload.orderCode}`).emit('order:progress', progressData);
        clientNs.to('orders:all').emit('order:progress', progressData);
      }
    });

    socket.on('job:failed', async (payload: { orderId: string; orderCode: string; error: string; ticketsConfirmed?: number; ticketsTarget?: number }) => {
      const worker = connectedWorkers.get(workerId);
      if (worker) worker.activeJobs.delete(payload.orderId);

      const groupCheck = await sqlClient.query("SELECT id FROM group_chest_jobs WHERE order_id=$1", [payload.orderId]);
      if (groupCheck.rows[0]) {
        await sqlClient.query("UPDATE group_chest_jobs SET status='failed', updated_at=NOW() WHERE order_id=$1", [payload.orderId]);
        await sqlClient.query("UPDATE orders SET status='failed', updated_at=NOW() WHERE id=$1", [payload.orderId]);
      } else {
        // Persist failure to DB
        updateProviderOrderProgress({
          orderId: payload.orderId,
          orderCode: payload.orderCode,
          status: 'failed',
          ticketsConfirmed: payload.ticketsConfirmed || 0,
          ticketsTarget: payload.ticketsTarget || 0,
          completedRequests: 0,
          totalRequests: 0,
          message: payload.error,
        }).catch(err => {
          process.stderr.write(JSON.stringify({ level: 'error', message: 'DB update failed for job:failed', error: String(err) }) + '\n');
        });
      }

      if (clientNs && payload.orderCode) {
        const progressData = {
          orderCode: payload.orderCode,
          status: 'failed' as const,
          ticketsTarget: payload.ticketsTarget || 0,
          ticketsConfirmed: payload.ticketsConfirmed || 0,
          completedRequests: 0,
          totalRequests: 0,
          progressPercent: 0,
          message: payload.error,
        };
        clientNs.to(`order:${payload.orderCode}`).emit('order:progress', progressData);
        clientNs.to('orders:all').emit('order:progress', progressData);
      }
    });

    socket.on('job:group-result', async (payload: GroupJobResultPayload) => {
      try {
        await sqlClient.query(`
          UPDATE group_chest_job_items
          SET status=$1, result=$2::jsonb, error_message=$3, updated_at=NOW()
          WHERE (id=$4 OR external_account_id=$6) AND job_id=(SELECT id FROM group_chest_jobs WHERE order_id=$5)
        `, [payload.status, JSON.stringify(payload.result || {}), payload.error || null, payload.itemId || null, payload.orderId, payload.externalAccountId || null]);
        await sqlClient.query(`
          UPDATE group_chest_jobs
          SET completed_count=(SELECT count(*) FROM group_chest_job_items WHERE job_id=group_chest_jobs.id AND status='success'),
              failed_count=(SELECT count(*) FROM group_chest_job_items WHERE job_id=group_chest_jobs.id AND status='failed'),
              status=CASE WHEN (SELECT count(*) FROM group_chest_job_items WHERE job_id=group_chest_jobs.id AND status IN ('queued','processing'))=0
                THEN CASE WHEN (SELECT count(*) FROM group_chest_job_items WHERE job_id=group_chest_jobs.id AND status='failed')>0 THEN 'failed' ELSE 'completed' END
                ELSE 'processing' END,
              updated_at=NOW()
          WHERE order_id=$1
        `, [payload.orderId]);
        const state = await sqlClient.query<{ order_code: string; status: string; completed_count: number; item_count: number }>(`
          SELECT o.order_code, gcj.status, gcj.completed_count, gcj.item_count
          FROM orders o JOIN group_chest_jobs gcj ON gcj.order_id=o.id WHERE o.id=$1
        `, [payload.orderId]);
        const row = state.rows[0];
        if (row) {
          const done = row.status === 'completed' || row.status === 'failed';
          await sqlClient.query("UPDATE orders SET status=$1, updated_at=NOW(), completed_at=CASE WHEN $1 IN ('completed','failed') THEN NOW() ELSE completed_at END WHERE id=$2", [row.status, payload.orderId]);
          if (clientNs) {
            clientNs.to(`order:${row.order_code}`).emit('order:progress', {
              orderCode: row.order_code,
              status: row.status,
              ticketsTarget: row.item_count,
              ticketsConfirmed: row.completed_count,
              completedRequests: row.completed_count,
              totalRequests: row.item_count,
              progressPercent: row.item_count ? Math.round(row.completed_count * 100 / row.item_count) : 0,
              message: done ? 'Mở rương nhóm đã kết thúc' : undefined,
            });
            clientNs.to(`order:${row.order_code}`).emit('group-chest:item-result', {
              orderCode: row.order_code,
              itemId: payload.itemId,
              externalAccountId: payload.externalAccountId,
              status: payload.status,
              result: payload.result,
              error: payload.error,
            });
          }
        }
      } catch (error) {
        process.stderr.write(JSON.stringify({ level: 'error', message: 'group result update failed', error: String(error) }) + '\n');
      }
    });

    socket.on('disconnect', (reason) => {
      connectedWorkers.delete(workerId);
      process.stdout.write(JSON.stringify({ level: 'info', message: 'worker disconnected', workerId, reason, remaining: connectedWorkers.size }) + '\n');
    });
  });

  // ─── /client namespace ──────────────────────────────────────────────────

  clientNs = io.of('/client');

  clientNs.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth?.token;
      if (!token) return next(new Error('Authentication required'));

      const { payload } = await jwtVerify(token, new TextEncoder().encode(env.accessSecret));
      if (!payload.sub) return next(new Error('Invalid token'));

      const [user] = await db.select({ id: users.id, role: users.role, status: users.status }).from(users).where(eq(users.id, payload.sub));
      if (!user || user.status !== 'active') return next(new Error('Account inactive'));

      // Attach user info to socket data
      (socket as any).userId = user.id;
      (socket as any).userRole = user.role;
      next();
    } catch {
      next(new Error('Authentication failed'));
    }
  });

  clientNs.on('connection', (socket) => {
    // Client joins a room for a specific order to receive realtime updates
    socket.on('order:subscribe', (orderCode: string) => {
      if (typeof orderCode === 'string' && orderCode.length > 0 && orderCode.length < 100) {
        socket.join(`order:${orderCode}`);
      }
    });

    socket.on('order:unsubscribe', (orderCode: string) => {
      if (typeof orderCode === 'string') {
        socket.leave(`order:${orderCode}`);
      }
    });

    // Admin can subscribe to all order updates
    socket.on('orders:subscribe-all', () => {
      if ((socket as any).userRole === 'admin') {
        socket.join('orders:all');
      }
    });

    socket.on('disconnect', () => {
      // Cleanup is automatic with Socket.io
    });
  });

  return io;
}

// ─── Public API for worker.ts to dispatch jobs ──────────────────────────────

/**
 * Check if any AutoChungSuc worker is connected and available.
 */
export function hasAvailableWorker(): boolean {
  return connectedWorkers.size > 0;
}

/**
 * Get count of connected workers.
 */
export function getWorkerCount(): number {
  return connectedWorkers.size;
}

/**
 * Dispatch a job to the least-busy connected worker.
 * Returns true if dispatched, false if no worker available.
 */
export function dispatchJobToWorker(payload: JobDispatchPayload): boolean {
  if (connectedWorkers.size === 0) return false;

  // Find worker with fewest active jobs
  let bestWorker: { socket: Socket; activeJobs: Set<string> } | null = null;
  let bestCount = Infinity;

  for (const worker of connectedWorkers.values()) {
    if (worker.activeJobs.size < bestCount) {
      bestCount = worker.activeJobs.size;
      bestWorker = worker;
    }
  }

  if (!bestWorker) return false;

  bestWorker.activeJobs.add(payload.orderId);
  bestWorker.socket.emit('job:dispatch', payload);
  return true;
}

/**
 * Emit order progress to subscribed FE clients.
 * Used by worker.ts when syncing from DB/external sources.
 */
export function emitOrderProgress(orderCode: string, data: {
  status: string;
  ticketsTarget: number;
  ticketsConfirmed: number;
  completedRequests: number;
  progressPercent: number;
}) {
  if (!clientNs) return;
  clientNs.to(`order:${orderCode}`).emit('order:progress', {
    orderCode,
    ...data,
  });
  // Also emit to admin "all orders" room
  clientNs.to('orders:all').emit('order:progress', {
    orderCode,
    ...data,
  });
}

/**
 * Get info about connected workers (for admin API).
 */
export function getWorkersInfo() {
  const workers: { id: string; activeJobs: number; connectedAt: string }[] = [];
  for (const [id, worker] of connectedWorkers) {
    workers.push({
      id,
      activeJobs: worker.activeJobs.size,
      connectedAt: new Date().toISOString(), // approximate
    });
  }
  return {
    count: connectedWorkers.size,
    workers,
  };
}

// ─── DB persistence for worker events ────────────────────────────────────────

/**
 * Update provider_orders and orders tables when worker reports progress/completion/failure.
 */
async function updateProviderOrderProgress(payload: {
  orderId: string;
  orderCode?: string;
  status: string;
  ticketsConfirmed: number;
  ticketsTarget: number;
  completedRequests: number;
  totalRequests: number;
  message?: string;
}) {
  const responsePayload = {
    status: payload.status,
    ticketsTarget: payload.ticketsTarget,
    ticketsConfirmed: payload.ticketsConfirmed,
    completedRequests: payload.completedRequests,
    totalRequests: payload.totalRequests,
    // Also store snake_case versions for compatibility with syncProcessingOrders
    tickets_target: payload.ticketsTarget,
    tickets_confirmed: payload.ticketsConfirmed,
    completed_requests: payload.completedRequests,
    error: payload.message,
    updatedAt: new Date().toISOString(),
  };

  const dbStatus = payload.status === 'completed' ? 'completed'
    : payload.status === 'failed' ? 'failed'
    : payload.status === 'cancelled' ? 'cancelled'
    : 'processing';

  await sqlClient.query(`
    UPDATE provider_orders
    SET status = $1, response_payload = $2::jsonb
    WHERE order_id = $3
  `, [dbStatus, JSON.stringify(responsePayload), payload.orderId]);

  if (payload.status === 'completed') {
    await sqlClient.query(
      "UPDATE orders SET status='completed', updated_at=NOW(), completed_at=NOW() WHERE id=$1 AND status='processing'",
      [payload.orderId]
    );
    await sqlClient.query(
      "INSERT INTO order_status_logs(order_id, from_status, to_status, actor_type, reason) VALUES($1, 'processing', 'completed', 'system', 'AutoChungSuc worker completed all tickets')",
      [payload.orderId]
    );
  } else if (payload.status === 'failed') {
    await sqlClient.query(
      "UPDATE orders SET status='failed', updated_at=NOW() WHERE id=$1 AND status='processing'",
      [payload.orderId]
    );
    await sqlClient.query(
      "INSERT INTO order_status_logs(order_id, from_status, to_status, actor_type, reason) VALUES($1, 'processing', 'failed', 'system', $2)",
      [payload.orderId, payload.message || 'Worker reported failure']
    );
  }
}
