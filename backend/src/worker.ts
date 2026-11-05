import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { sqlClient } from './db/sql.js';
import { chungSucClient, extractEventCode } from './modules/chungsuc-adapter.js';
import { hasAvailableWorker, dispatchJobToWorker, emitOrderProgress } from './modules/ws.js';

const workerId = randomUUID();

/**
 * Determine the dispatch mode for ChungSuc orders.
 *
 * Configured modes:
 *   - 'auto': Prefer PC worker via WebSocket, fallback to external 3rd-party API
 *   - 'pc_only': Only dispatch to PC worker. If offline, keep job pending (no 3rd-party cost)
 *   - 'api_only': Only dispatch to external 3rd-party API
 */
type DispatchMode = 'ws_worker' | 'external_api' | 'none';

function getDispatchMode(configuredMode: string = 'auto'): DispatchMode {
  if (configuredMode === 'pc_only') {
    if (hasAvailableWorker()) return 'ws_worker';
    return 'none';
  }

  if (configuredMode === 'api_only') {
    if (chungSucClient.isConfigured()) return 'external_api';
    return 'none';
  }

  // 'auto' mode: prefer PC worker, fallback to external API
  if (hasAvailableWorker()) return 'ws_worker';
  if (chungSucClient.isConfigured()) return 'external_api';
  return 'none';
}

/**
 * Xử lý job gửi đơn - ưu tiên dispatch qua WebSocket tới AutoChungSuc worker,
 * fallback sang external API nếu không có worker.
 */
async function processSendProviderOrder(jobId: string, orderId: string) {
  // 1. Kiểm tra trạng thái đơn hàng và lấy cấu hình số request của sản phẩm
  const orderRes = await sqlClient.query(`
    SELECT o.*, oi.customer_input, oi.quantity, p.name as product_name, p.input_schema
    FROM orders o
    LEFT JOIN order_items oi ON oi.order_id = o.id
    LEFT JOIN products p ON p.id = oi.product_id
    WHERE o.id = $1
    LIMIT 1
  `, [orderId]);
  const order = orderRes.rows[0];

  if (!order) {
    await sqlClient.query("UPDATE outbox_jobs SET status='completed', locked_at=NULL WHERE id=$1", [jobId]);
    return;
  }

  // 2. Kiểm tra xem provider 'chungsuc' có đang BẬT không
  const provRes = await sqlClient.query("SELECT * FROM providers WHERE code='chungsuc' AND is_active=true LIMIT 1");
  const provider = provRes.rows[0];

  if (!provider) {
    await sqlClient.query("UPDATE outbox_jobs SET status='completed', locked_at=NULL, last_error='ChungSuc provider is inactive' WHERE id=$1", [jobId]);
    return;
  }

  // 3. Trích xuất mã code và số lượng
  const input = order.customer_input || {};
  const rawCode = input.accountId || input.code || input.eventCode || '';
  const cleanCode = extractEventCode(rawCode);

  if (!cleanCode) {
    await sqlClient.query("UPDATE outbox_jobs SET status='failed', locked_at=NULL, last_error='No valid code found' WHERE id=$1", [jobId]);
    return;
  }

  let requestsPerItem = 1;
  const pSchema = order.input_schema;
  if (pSchema && typeof pSchema === 'object') {
    if (typeof pSchema.requestsPerItem === 'number' && pSchema.requestsPerItem > 0) {
      requestsPerItem = Math.floor(pSchema.requestsPerItem);
    } else if (typeof pSchema.providerQuantity === 'number' && pSchema.providerQuantity > 0) {
      requestsPerItem = Math.floor(pSchema.providerQuantity);
    }
  }

  const itemQty = Math.max(1, Number(order.quantity) || 1);
  const quantity = Math.max(1, itemQty * requestsPerItem);
  const idempotencyKey = `cs_${order.order_code || order.id}`;

  const configuredMode = provider.dispatch_mode || 'auto';
  const mode = getDispatchMode(configuredMode);

  if (mode === 'none') {
    const reason = configuredMode === 'pc_only'
      ? 'Đang chờ PC Worker kết nối (Chế độ Chỉ dùng PC)'
      : 'Không có worker kết nối và API ChungSuc chưa cấu hình';
    // Leave job as pending (with attempts not incremented) so it retries automatically next tick
    await sqlClient.query(
      "UPDATE outbox_jobs SET status='pending', locked_at=NULL, locked_by=NULL, last_error=$2 WHERE id=$1",
      [jobId, reason]
    );
    return;
  }

  try {
    if (mode === 'ws_worker') {
      // ─── Dispatch via WebSocket to AutoChungSuc worker ──────────────
      const dispatched = dispatchJobToWorker({
        jobId,
        orderId: order.id,
        orderCode: order.order_code,
        code: cleanCode,
        target: quantity * 38, // default 38 tickets per request for MXT mode
        quantity,
      });

      if (!dispatched) {
        // Worker disconnected between check and dispatch; retry next tick
        await sqlClient.query(
          "UPDATE outbox_jobs SET status='pending', locked_at=NULL, locked_by=NULL, last_error='Worker disconnected during dispatch' WHERE id=$1",
          [jobId]
        );
        return;
      }

      // Create provider_orders record for tracking
      await sqlClient.query(`
        INSERT INTO provider_orders(order_id, provider_id, external_order_id, idempotency_key, status, request_payload, response_payload)
        VALUES($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb)
        ON CONFLICT (idempotency_key) DO UPDATE
        SET status = EXCLUDED.status,
            response_payload = EXCLUDED.response_payload
      `, [
        order.id,
        provider.id,
        `ws_${order.order_code}`,  // local worker ID prefix
        idempotencyKey,
        'processing',
        JSON.stringify({ codes: [cleanCode], quantity, mode: 'ws_worker', customerLabel: order.order_code }),
        JSON.stringify({ dispatched: true, dispatchedAt: new Date().toISOString() }),
      ]);

      await sqlClient.query("UPDATE orders SET status='processing', updated_at=NOW() WHERE id=$1 AND status='queued'", [order.id]);
      await sqlClient.query("INSERT INTO order_status_logs(order_id, from_status, to_status, actor_type, reason) VALUES($1, 'queued', 'processing', 'system', 'Dispatched to AutoChungSuc worker via WebSocket')", [order.id]);
      await sqlClient.query("UPDATE outbox_jobs SET status='completed', locked_at=NULL WHERE id=$1", [jobId]);

    } else {
      // ─── Fallback: dispatch via external chungsuc.io.vn API ─────────
      const csResponse = await chungSucClient.createHomeOrder({
        codes: [cleanCode],
        quantity,
        customerLabel: order.order_code,
        idempotencyKey,
      });

      const firstOrder = csResponse.orders?.[0];
      const externalOrderId = firstOrder ? String(firstOrder.id) : null;

      await sqlClient.query(`
        INSERT INTO provider_orders(order_id, provider_id, external_order_id, idempotency_key, status, request_payload, response_payload)
        VALUES($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb)
        ON CONFLICT (idempotency_key) DO UPDATE
        SET external_order_id = EXCLUDED.external_order_id,
            status = EXCLUDED.status,
            response_payload = EXCLUDED.response_payload
      `, [
        order.id,
        provider.id,
        externalOrderId,
        idempotencyKey,
        'processing',
        JSON.stringify({ codes: [cleanCode], quantity, mode: 'external_api', customerLabel: order.order_code }),
        JSON.stringify(csResponse),
      ]);

      await sqlClient.query("UPDATE orders SET status='processing', updated_at=NOW() WHERE id=$1 AND status='queued'", [order.id]);
      await sqlClient.query("INSERT INTO order_status_logs(order_id, from_status, to_status, actor_type, reason) VALUES($1, 'queued', 'processing', 'system', 'ChungSuc external API accepted order')", [order.id]);
      await sqlClient.query("UPDATE outbox_jobs SET status='completed', locked_at=NULL WHERE id=$1", [jobId]);
    }
  } catch (err: any) {
    const errorMsg = err.message || String(err);
    await sqlClient.query(
      "UPDATE outbox_jobs SET status='pending', attempts=attempts+1, locked_at=NULL, locked_by=NULL, last_error=$2 WHERE id=$1",
      [jobId, errorMsg]
    );
  }
}

/**
 * Thăm dò và đồng bộ tiến độ các đơn hàng đang xử lý.
 * - Đơn dispatch qua WS: progress được worker push trực tiếp qua ws.ts event handlers.
 *   Sync loop chỉ cần kiểm tra đơn external API.
 * - Đơn dispatch qua external API: polling chungsuc.io.vn như cũ.
 */
async function syncProcessingOrders() {
  const activeOrdersRes = await sqlClient.query(`
    SELECT po.id as po_id, po.external_order_id, po.response_payload,
           o.id as order_id, o.order_code, o.status as order_status
    FROM provider_orders po
    JOIN orders o ON o.id = po.order_id
    JOIN providers p ON p.id = po.provider_id
    WHERE p.code = 'chungsuc'
      AND o.status IN ('queued', 'sending', 'processing')
      AND po.external_order_id IS NOT NULL
    LIMIT 20
  `);

  for (const row of activeOrdersRes.rows) {
    try {
      const externalId = String(row.external_order_id);

      // Orders dispatched via WS have external_order_id starting with "ws_"
      // Their progress is managed by ws.ts event handlers directly, skip here.
      if (externalId.startsWith('ws_')) {
        continue;
      }

      // External API orders: poll chungsuc.io.vn
      if (!chungSucClient.isConfigured()) continue;

      const live = await chungSucClient.getOrder(row.external_order_id);
      let mappedStatus = 'processing';
      if (live.status === 'completed') mappedStatus = 'completed';
      else if (live.status === 'cancelled') mappedStatus = 'cancelled';
      else if (live.status === 'needs_review') mappedStatus = 'processing';

      await sqlClient.query(`
        UPDATE provider_orders
        SET status = $1, response_payload = $2::jsonb
        WHERE id = $3
      `, [mappedStatus, JSON.stringify(live), row.po_id]);

      // Emit realtime progress to FE
      emitOrderProgress(row.order_code, {
        status: mappedStatus,
        ticketsTarget: live.tickets_target || 0,
        ticketsConfirmed: live.tickets_confirmed || 0,
        completedRequests: live.completed_requests || 0,
        progressPercent: live.tickets_target > 0
          ? Math.min(100, Math.round((live.tickets_confirmed / live.tickets_target) * 100))
          : (mappedStatus === 'completed' ? 100 : 0),
      });

      if (mappedStatus === 'completed') {
        await sqlClient.query("UPDATE orders SET status='completed', updated_at=NOW(), completed_at=NOW() WHERE id=$1", [row.order_id]);
        await sqlClient.query("INSERT INTO order_status_logs(order_id, from_status, to_status, actor_type, reason) VALUES($1, 'processing', 'completed', 'system', 'ChungSuc completed tickets')", [row.order_id]);
      } else if (mappedStatus === 'cancelled') {
        await sqlClient.query("UPDATE orders SET status='cancelled', updated_at=NOW() WHERE id=$1", [row.order_id]);
        await sqlClient.query("INSERT INTO order_status_logs(order_id, from_status, to_status, actor_type, reason) VALUES($1, 'processing', 'cancelled', 'system', 'ChungSuc cancelled order')", [row.order_id]);
      }
    } catch {
      // Bỏ qua lỗi tạm thời khi thăm dò
    }
  }
}

async function tick() {
  // 1. Quét nạp tiền hết hạn
  await sqlClient.query("UPDATE deposits SET status='expired' WHERE status='pending' AND expires_at < NOW()");

  // 2. Mở khóa các outbox job bị treo
  await sqlClient.query("UPDATE outbox_jobs SET status='pending', locked_at=NULL, locked_by=NULL WHERE status='processing' AND locked_at < NOW() - INTERVAL '5 minutes'");

  // 3. Khóa và lấy các job gửi đơn nhà cung cấp đang chờ
  const pendingJobsRes = await sqlClient.query(`
    UPDATE outbox_jobs
    SET status = 'processing', locked_at = NOW(), locked_by = $1
    WHERE id IN (
      SELECT id FROM outbox_jobs
      WHERE status = 'pending' AND type = 'SEND_PROVIDER_ORDER' AND available_at <= NOW() AND attempts < 5
      ORDER BY created_at ASC
      LIMIT 10
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, aggregate_id
  `, [workerId]);

  for (const job of pendingJobsRes.rows) {
    await processSendProviderOrder(job.id, job.aggregate_id);
  }

  // 4. Đồng bộ tiến độ các đơn hàng đang chạy
  await syncProcessingOrders();
}

async function main() {
  const mode = hasAvailableWorker() ? 'WS worker' : (chungSucClient.isConfigured() ? 'external API' : 'no provider');
  process.stdout.write(JSON.stringify({ level: 'info', workerId, message: `worker started (dispatch mode: ${mode})` }) + '\n');
  while (true) {
    try {
      await tick();
    } catch (error) {
      process.stderr.write(JSON.stringify({ level: 'error', workerId, message: String(error) }) + '\n');
    }
    await new Promise(resolve => setTimeout(resolve, 8_000));
  }
}

void main();
